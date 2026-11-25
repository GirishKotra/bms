var common = require('./common');

var BASE_URL = 'https://in.bookmyshow.com';
var CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';

// Regions are requested on behalf of this city (the list itself is not city specific).
var DEFAULT_REGION = { code: 'HYD', slug: 'hyderabad' };

// Names people use that are missing from BookMyShow's region data, mapped to ones that are there.
var CITY_ALIASES = { bangalore: 'bengaluru', calcutta: 'kolkata' };

// Lowercases and collapses whitespace so matching ignores case and spacing.
function normalize(text) {
    return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

// The words of text: runs of letters and digits, lowercased.
function words(text) {
    return normalize(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// text as its words joined by single spaces, so matching ignores case, punctuation and spacing.
function normalizeWords(text) {
    return words(text).join(' ');
}

// True if every word of query appears somewhere in text, ignoring case and punctuation.
function containsWords(text, query) {
    var haystack = normalize(text);
    return words(query).every(function (word) {
        return haystack.indexOf(word) !== -1;
    });
}

// An error that is worth one retry with fuller headers: BookMyShow (Cloudflare) answered with something
// other than what was asked for.
function blockedError(message) {
    var err = new Error(message);
    err.blocked = true;
    return err;
}

function apiHeaders(region, full) {
    var headers = {
        'user-agent': CHROME_UA,
        'accept': 'application/json',
        'x-app-code': 'WEB',
        'x-platform': 'WEB',
        'x-platform-code': 'WEB',
        'x-region-code': region.code,
        'x-region-slug': region.slug
    };
    if (full) {
        Object.assign(headers, {
            'accept-language': 'en-IN,en;q=0.9',
            'referer': BASE_URL + '/',
            'sec-fetch-site': 'same-origin',
            'sec-fetch-mode': 'cors',
            'sec-fetch-dest': 'empty'
        });
    }
    return headers;
}

function pageHeaders(full) {
    var headers = {
        'user-agent': CHROME_UA,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-IN,en;q=0.9',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'upgrade-insecure-requests': '1'
    };
    if (full) {
        Object.assign(headers, {
            'cache-control': 'max-age=0',
            'sec-fetch-user': '?1',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"macOS"'
        });
    }
    return headers;
}

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch (err) {
        throw blockedError('response is not JSON');
    }
}

// GET url and return parse(body). A 403 or a body parse() rejects with blockedError is retried once with
// makeHeaders(true); if that fails too the error says BookMyShow is probably blocking the request.
async function fetchBms(url, makeHeaders, parse) {
    var lastErr;
    for (var attempt = 0; attempt < 2; attempt++) {
        try {
            return parse(await common.fetchText(url, { headers: makeHeaders(attempt === 1) }));
        } catch (err) {
            if (!err.blocked && err.message !== 'HTTP 403') {
                throw err;
            }
            lastErr = err;
        }
    }
    throw new Error('BookMyShow refused the request (' + lastErr.message + '); it may be blocking automated requests, try again later');
}

function fetchApi(path, region) {
    return fetchBms(BASE_URL + path, function (full) { return apiHeaders(region, full); }, parseJson);
}

// ---- Cities ----

async function fetchRegions() {
    var data = await fetchApi('/api/explore/v1/discover/regions', DEFAULT_REGION);
    var bms = data && data.BookMyShow;
    var cities = bms && Array.isArray(bms.TopCities) ? bms.TopCities.concat(Array.isArray(bms.OtherCities) ? bms.OtherCities : []) : null;
    if (!cities) {
        throw new Error('unexpected response from the BookMyShow regions API');
    }
    return cities.filter(function (city) {
        return city && city.RegionCode && city.RegionName && city.RegionSlug;
    });
}

function cityNames(city) {
    return [city.RegionName, city.RegionSlug].concat(city.Alias || []).map(normalize);
}

// Resolves a city name (name, slug or alias, case-insensitive) to { code, name, slug }. An unknown name
// throws with the cities whose name contains it (or that it contains) as suggestions.
async function resolveCity(name) {
    var wanted = normalize(name);
    wanted = CITY_ALIASES[wanted] || wanted;
    var cities = await fetchRegions();
    var found = cities.filter(function (city) { return cityNames(city).indexOf(wanted) !== -1; })[0];
    if (found) {
        return { code: found.RegionCode, name: found.RegionName, slug: found.RegionSlug };
    }
    var close = cities.filter(function (city) {
        return cityNames(city).some(function (candidate) {
            return candidate.indexOf(wanted) !== -1 || wanted.indexOf(candidate) !== -1;
        });
    }).map(function (city) { return city.RegionName; });
    throw new Error('Unknown city "' + name + '"' + (close.length > 0 ? '. Did you mean: ' + close.slice(0, 10).join(', ') + '?' : ''));
}

// ---- Theatres ----

// Returns the JSON object literal that starts at text[start] (a "{").
function extractObject(text, start) {
    var depth = 0;
    var inString = false;
    var escaped = false;
    for (var i = start; i < text.length; i++) {
        var ch = text[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
        } else if (ch === '"') {
            inString = true;
        } else if (ch === '{') {
            depth++;
        } else if (ch === '}' && --depth === 0) {
            return text.slice(start, i + 1);
        }
    }
    throw blockedError('page has no complete __INITIAL_STATE__');
}

function parseVenuesPage(html) {
    var marker = html.match(/window\.__INITIAL_STATE__\s*=\s*/);
    if (!marker) {
        throw blockedError('page has no __INITIAL_STATE__');
    }
    var state;
    try {
        state = JSON.parse(extractObject(html, marker.index + marker[0].length));
    } catch (err) {
        throw blockedError('cannot parse __INITIAL_STATE__');
    }
    var queries = state.fetchVenuesListingApi && state.fetchVenuesListingApi.queries;
    var venues = [];
    Object.keys(queries || {}).forEach(function (key) {
        var found = queries[key] && queries[key].data && queries[key].data.venues;
        if (Array.isArray(found)) {
            venues = venues.concat(found);
        }
    });
    if (venues.length === 0) {
        throw new Error('no theatres in the cinemas page');
    }
    return venues.filter(function (venue) {
        return venue && venue.VenueCode && venue.VenueName;
    }).map(function (venue) {
        return { code: venue.VenueCode, name: venue.VenueName, address: venue.VenueAddress || '' };
    });
}

// Theatres of the city from its cinemas page (fragile: it is an HTML page behind Cloudflare).
function fetchCityTheatres(city) {
    return fetchBms(BASE_URL + '/' + city.slug + '/cinemas', pageHeaders, parseVenuesPage);
}

// Cards of one type ('venues', 'movies') from the search autosuggest. Search is not city scoped.
async function searchCards(city, text, type) {
    // Punctuation such as ":" makes the search API time out (HTTP 504), so only the words are sent.
    var path = '/api/v1/search/dynamic?q=' + encodeURIComponent(words(text).join(' ')) + '&instant=true&firstLoad=false';
    var data = await fetchApi(path, city);
    var widget = data && data.data && data.data.widgets && data.data.widgets['search-vi-v2-results'];
    var cards = widget && widget.data && widget.data.cards && widget.data.cards.data;
    if (!Array.isArray(cards)) {
        throw new Error('unexpected response from the BookMyShow search API');
    }
    return cards.map(function (card) { return card && card.data; }).filter(function (card) {
        return card && card.identifier && card['result-title'] && card.analytics && card.analytics.type === type;
    });
}

// Fallback for when the cinemas page cannot be read: theatres from search results that are in the city.
async function searchTheatres(city, text) {
    var cards = await searchCards(city, text, 'venues');
    return cards.filter(function (card) {
        var location = card['result-location'] || '';
        return normalize(location).indexOf(normalize(city.name)) !== -1;
    }).map(function (card) {
        return { code: card.identifier, name: card['result-title'], address: card['result-location'] || '' };
    });
}

// Theatres in the city whose name or address contains every word of text. A venue code equal to text
// (ignoring case) wins over everything else. fallbackNote(err) is called if the cinemas page failed and search
// was used instead.
async function findTheatres(city, text, fallbackNote) {
    var theatres;
    try {
        theatres = await fetchCityTheatres(city);
    } catch (err) {
        if (fallbackNote) {
            fallbackNote(err);
        }
        theatres = await searchTheatres(city, text);
    }
    var byCode = theatres.filter(function (theatre) { return normalize(theatre.code) === normalize(text); });
    if (byCode.length > 0) {
        return byCode;
    }
    return theatres.filter(function (theatre) {
        return containsWords(theatre.name + ' ' + theatre.address, text);
    });
}

// ---- Movies ----

// Movies whose title contains every word of text: [{ code, title, group }].
async function findMovies(city, text) {
    var cards = await searchCards(city, text, 'movies');
    return cards.filter(function (card) {
        return containsWords(card['result-title'], text);
    }).map(function (card) {
        return { code: card.identifier, title: card['result-title'], group: card.analytics.entity_group || '' };
    });
}

function collectChips(node, chips) {
    if (Array.isArray(node)) {
        node.forEach(function (item) { collectChips(item, chips); });
    } else if (node && typeof node === 'object') {
        var cta = node.cta;
        if (cta && cta.type === 'formatSelector' && cta.additionalData && /^ET\d+$/.test(cta.additionalData.eventCode)) {
            chips.push({ code: cta.additionalData.eventCode, format: node.title, language: cta.additionalData.language || '' });
        }
        Object.keys(node).forEach(function (key) { collectChips(node[key], chips); });
    }
}

function collectShows(widgets) {
    var shows = [];
    var list = widgets.filter(function (widget) { return widget && widget.type === 'groupList' && Array.isArray(widget.data); });
    list.forEach(function (widget) {
        widget.data.forEach(function (group) {
            (group.data || []).forEach(function (card) {
                var info = card.additionalData || {};
                (card.showtimesSections || []).forEach(function (section) {
                    (section.showtimes || []).forEach(function (show) {
                        var extra = show.additionalData || {};
                        shows.push({
                            venueCode: info.venueCode,
                            venueName: info.venueName,
                            date: extra.showDateCode,
                            attributes: [show.screenAttr, extra.attributes].filter(Boolean).join(' ')
                        });
                    });
                });
            });
        });
    });
    return shows;
}

// One edition (ET code) of a movie on a date, as seen from the city: { editions: [{ code, format, language }],
// shows: [{ venueCode, venueName, date, attributes }] }. A date that is not open returns the nearest open
// date, so each show carries its own date.
async function fetchMovieDay(city, etCode, date) {
    var path = '/api/movies-data/v5/showtimes-by-event/primary-dynamic?etCodes=' + encodeURIComponent(etCode) +
        '&dateCode=' + date + '&isDesktop=true&regionCode=' + encodeURIComponent(city.code) +
        '&xLocationShared=false&memberId=&lsId=&subCode=&appCode=WEB&language=&refEventCode=';
    var data = await fetchApi(path, city);
    var body = data && data.data;
    if (!body || !Array.isArray(body.showtimeWidgets)) {
        throw new Error('unexpected response from the BookMyShow movie API for ' + etCode);
    }
    var editions = [];
    collectChips(body.bottomSheetData, editions);
    return { editions: editions, shows: collectShows(body.showtimeWidgets) };
}

// The event dimensions BookMyShow lists for the movie (e.g. ["2D", "DOLBY CINEMA 2D"]), from its page.
function fetchPlannedFormats(city, etCode) {
    return fetchBms(BASE_URL + '/movies/' + city.slug + '/x/' + encodeURIComponent(etCode), pageHeaders, function (html) {
        var match = html.match(/"meta":\{"event":(\{[^{}]*\})\}/);
        var event;
        try {
            event = match && JSON.parse(match[1]);
        } catch (err) {
            event = null;
        }
        if (!event) {
            throw blockedError('movie page has no event metadata');
        }
        if (typeof event.eventDimension !== 'string') {
            throw new Error('movie page lists no event dimensions');
        }
        return event.eventDimension.split(',').map(function (item) { return item.trim(); }).filter(Boolean);
    });
}

// ---- Shows at a theatre ----

function venueHeaders(city) {
    return function (full) { return full ? apiHeaders(city, true) : {}; };
}

// What BookMyShow lists for a venue around a date (the venue's open dates come with every answer):
// { date, name, openDates, shows }. date is the date the shows are for: a date that is not open returns the
// nearest open date, and an unknown venue (or one with nothing open) returns no shows and date null.
// Each show: { title, edition, language, attributes, screen, sessionId, time: 'HH:MM' }.
async function fetchVenueDay(venueCode, date) {
    var url = BASE_URL + '/api/v3/mobile/showtimes/byvenue?dateCode=' + date + '&venueCode=' + encodeURIComponent(venueCode);
    var data = await fetchBms(url, venueHeaders(DEFAULT_REGION), parseJson);
    if (!data || typeof data !== 'object' || !Array.isArray(data.ShowDetails)) {
        throw new Error('unexpected response for venue ' + venueCode + ': no ShowDetails array');
    }
    var openDates = (Array.isArray(data.ShowDatesArray) ? data.ShowDatesArray : []).filter(function (item) {
        return item && item.DateCode && !item.isDisabled;
    }).map(function (item) { return item.DateCode; });
    var day = data.ShowDetails[0];
    var result = { date: null, name: null, openDates: openDates, shows: [] };
    if (!day || typeof day.Date !== 'string' || !Array.isArray(day.Event)) {
        return result;
    }
    result.date = day.Date;
    result.name = day.Venues && day.Venues.VenueName || null;
    day.Event.forEach(function (event) {
        (event && Array.isArray(event.ChildEvents) ? event.ChildEvents : []).forEach(function (child) {
            (child && Array.isArray(child.ShowTimes) ? child.ShowTimes : []).forEach(function (show) {
                if (show && typeof show.Attributes === 'string' && typeof show.ShowDateTime === 'string') {
                    result.shows.push({
                        title: event.EventTitle || '',
                        edition: child.EventDimension || '',
                        language: child.EventLanguage || '',
                        attributes: show.Attributes,
                        screen: show.ScreenName || '',
                        sessionId: show.SessionId,
                        time: show.ShowDateTime.slice(8, 10) + ':' + show.ShowDateTime.slice(10, 12)
                    });
                }
            });
        });
    });
    return result;
}

module.exports = {
    normalize: normalize,
    words: words,
    normalizeWords: normalizeWords,
    containsWords: containsWords,
    resolveCity: resolveCity,
    findTheatres: findTheatres,
    findMovies: findMovies,
    fetchMovieDay: fetchMovieDay,
    fetchPlannedFormats: fetchPlannedFormats,
    fetchVenueDay: fetchVenueDay
};
