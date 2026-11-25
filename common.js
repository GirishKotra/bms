var fs = require('fs');

var REQUEST_TIMEOUT_MS = 15000;

// Consecutive transient failures before a "watcher failing" ntfy message is sent.
var TRANSIENT_FAILURE_THRESHOLD = 5;

// Largest delay setTimeout accepts; bigger values fire after 1ms.
var MAX_TIMER_MS = 2147483647;

function fail(message) {
    console.error(message);
    process.exit(1);
}

// Errors are transient (network/HTTP/API hiccups: keep polling) unless created
// by fatalError(), which marks a data-format problem that retrying won't fix.
function fatalError(message) {
    var err = new Error(message);
    err.fatal = true;
    return err;
}

// Option types: 'string' (non-empty), 'int' (min..MAX_TIMER_MS), and 'list'
// (non-empty array of non-empty strings, trimmed, each accepted by
// option.validate(item) if given; option.itemHint describes an item in the
// error message).
function checkOption(option, value, label) {
    if (option.type === 'int') {
        if (!Number.isInteger(value) || value < option.min || value > MAX_TIMER_MS) {
            fail(label + ' must be an integer from ' + option.min + ' to ' + MAX_TIMER_MS + ', got ' + JSON.stringify(value));
        }
    } else if (option.type === 'list') {
        var valid = Array.isArray(value) && value.length > 0 && value.every(function (item) {
            return typeof item === 'string' && item.trim() !== '' && (!option.validate || option.validate(item.trim()));
        });
        if (!valid) {
            fail(label + ' must be a non-empty list of ' + option.itemHint + ', got ' + JSON.stringify(value));
        }
        var items = value.map(function (item) { return item.trim(); });
        return items.filter(function (item, index) { return items.indexOf(item) === index; });
    } else if (typeof value !== 'string' || value === '') {
        fail(label + ' must be a non-empty string, got ' + JSON.stringify(value));
    }
    return value;
}

function parseCliValue(option, text) {
    var value = option.type === 'int' && /^\d+$/.test(text) ? Number(text) : text;
    if (option.type === 'list') {
        value = text.split(',').map(function (item) { return item.trim(); });
    }
    return checkOption(option, value, '--' + option.flag);
}

function loadConfigFile(configPath, spec) {
    var config;
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
        fail('Cannot load config file ' + configPath + ': ' + err.message);
    }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        fail('Config file ' + configPath + ' must contain a JSON object');
    }
    var known = spec.options.map(function (option) { return option.key; }).concat(spec.extraConfigKeys || []);
    Object.keys(config).forEach(function (key) {
        if (known.indexOf(key) === -1) {
            fail('Unknown key "' + key + '" in config file ' + configPath + ' (allowed: ' + known.join(', ') + ')');
        }
    });
    return config;
}

// Splits argv into { help, switches: { <switch name>: true }, flags: { <flag name>: <text value> } }.
function parseCli(argv, spec) {
    var cli = { help: false, switches: {}, flags: {} };
    var switches = spec.switches || [];
    var valueFlags = spec.options.map(function (option) { return option.flag; }).concat(spec.extraFlags || [], ['config']);
    argv.forEach(function (arg) {
        var match = arg.match(/^--([^=]+)=(.*)$/);
        if (arg.slice(0, 2) === '--' && switches.indexOf(arg.slice(2)) !== -1) {
            cli.switches[arg.slice(2)] = true;
        } else if (arg === '--help' || arg === '-h') {
            cli.help = true;
        } else if (match && valueFlags.indexOf(match[1]) !== -1) {
            cli.flags[match[1]] = match[2];
        } else {
            fail('Unknown option: ' + arg + ' (see --help)');
        }
    });
    return cli;
}

/*
 * Precedence, lowest to highest: defaults < config file < env vars < CLI flags.
 * spec: { help, options, defaults, switches, extraFlags, extraConfigKeys,
 *         applyConfig(config, settings), applyCli(cli, settings) }
 * The last two handle whatever the script keeps outside the options table.
 */
function loadSettings(argv, spec) {
    if (argv.indexOf('--help') !== -1 || argv.indexOf('-h') !== -1) {
        console.log(spec.help);
        process.exit(0);
    }
    var cli = parseCli(argv, spec);
    var settings = Object.assign({}, spec.defaults);

    if (cli.flags.config !== undefined) {
        var config = loadConfigFile(cli.flags.config, spec);
        spec.options.forEach(function (option) {
            if (config[option.key] !== undefined) {
                settings[option.key] = checkOption(option, config[option.key], 'config "' + option.key + '"');
            }
        });
        if (spec.applyConfig) {
            spec.applyConfig(config, settings);
        }
    }

    if (process.env.NTFY_TOPIC) {
        settings.ntfyTopic = process.env.NTFY_TOPIC;
    }

    spec.options.forEach(function (option) {
        if (cli.flags[option.flag] !== undefined) {
            settings[option.key] = parseCliValue(option, cli.flags[option.flag]);
        }
    });
    if (spec.applyCli) {
        spec.applyCli(cli, settings);
    }
    return settings;
}

// Returns the response body text; any failure here is transient.
async function fetchText(url, options) {
    var status, text;
    try {
        var response = await fetch(url, Object.assign({}, options, {
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        }));
        status = response.status;
        text = await response.text();
    } catch (err) {
        throw new Error('request failed: ' + err.message);
    }
    if (status !== 200) {
        throw new Error('HTTP ' + status);
    }
    return text;
}

// Returns true if ntfy accepted the message; failures are logged.
async function sendNtfy(topic, message) {
    try {
        var response = await fetch('https://ntfy.sh/' + topic, {
            method: 'POST',
            body: message,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (!response.ok) {
            console.error('ntfy alert failed:', response.status, await response.text());
            return false;
        }
        return true;
    } catch (err) {
        console.error('ntfy alert failed:', err.message);
        return false;
    }
}

// Sends the message alertRepeat times, alertRepeatIntervalMs apart. The
// returned promise resolves once every send has finished, to true if at least
// one of them succeeded.
function alertBurst(settings, message) {
    console.log('ALERT:', message);
    var sends = [];
    for (var burst = 0; burst < settings.alertRepeat; burst++) {
        sends.push(new Promise(function (resolve) {
            setTimeout(function () {
                sendNtfy(settings.ntfyTopic, message).then(resolve);
            }, burst * settings.alertRepeatIntervalMs);
        }));
    }
    return Promise.all(sends).then(function (results) {
        return results.indexOf(true) !== -1;
    });
}

/*
 * Runs poll() every settings.pollIntervalMs; the next poll is scheduled only
 * after the current one is handled, so requests never overlap. poll() may
 * return true to stop polling. Transient errors are logged and polling
 * continues (one "<name> failing" ntfy message per streak of
 * TRANSIENT_FAILURE_THRESHOLD consecutive failures); a fatal error stops the
 * watcher (after telling ntfy) with exit code 1. With once, poll() runs a
 * single time, errors set exit code 1 and nothing is sent to ntfy.
 */
function runPoller(name, settings, once, poll) {
    var consecutiveFailures = 0;
    var failureAlertSent = false;

    async function recordTransientFailure(err) {
        consecutiveFailures++;
        if (consecutiveFailures >= TRANSIENT_FAILURE_THRESHOLD && !failureAlertSent) {
            failureAlertSent = true;
            await sendNtfy(settings.ntfyTopic, name + ' failing: ' + err.message);
        }
    }

    async function pollOnce() {
        try {
            var done = await poll();
            consecutiveFailures = 0;
            failureAlertSent = false;
            if (done) {
                return;
            }
        } catch (err) {
            console.error((err.fatal ? 'Fatal error: ' : 'Transient error: ') + err.message);
            if (once) {
                process.exitCode = 1;
            } else if (err.fatal) {
                process.exitCode = 1;
                await sendNtfy(settings.ntfyTopic, name + ' stopped: ' + err.message);
                return;
            } else {
                await recordTransientFailure(err);
            }
        }
        if (!once) {
            setTimeout(pollOnce, settings.pollIntervalMs);
        }
    }

    pollOnce();
}

module.exports = {
    fail: fail,
    fatalError: fatalError,
    loadSettings: loadSettings,
    fetchText: fetchText,
    alertBurst: alertBurst,
    runPoller: runPoller
};
