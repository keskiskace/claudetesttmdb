// IPTV Stremio Addon Core - Version Complète (Redis + Blacklist + Rails + TMDB)
require('dotenv').config();

const { addonBuilder } = require("stremio-addon-sdk");
const crypto = require("crypto");
const LRUCache = require("./lruCache");
const fetch = require('node-fetch');

// --- INITIALISATION REDIS ---
let redisClient = null;
if (process.env.REDIS_URL) {
    try {
        const { Redis } = require('ioredis');
        redisClient = new Redis(process.env.REDIS_URL, {
            lazyConnect: true,
            maxRetriesPerRequest: 2
        });
        redisClient.on('error', e => console.error('[REDIS] Error:', e.message));
        redisClient.connect().catch(err => console.error('[REDIS] Connect failed:', err.message));
        console.log('[REDIS] Enabled');
    } catch (e) {
        console.warn('[REDIS] ioredis not installed, falling back to LRU');
        redisClient = null;
    }
}

const ADDON_NAME = "IPTV V5";
const ADDON_ID = "keskiskace.xtream.addon.v1.0.0";

// --- CONFIGURATION DU CACHE ---
const CACHE_ENABLED = (process.env.CACHE_ENABLED || 'true').toLowerCase() !== 'false';
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || (6 * 3600 * 1000).toString(), 10);
const MAX_CACHE_ENTRIES = parseInt(process.env.MAX_CACHE_ENTRIES || '500', 10);

const dataCache = new LRUCache({ max: MAX_CACHE_ENTRIES, ttl: CACHE_TTL_MS });

// Helpers Redis
async function redisGetJSON(key) {
    if (!redisClient) return null;
    try {
        const raw = await redisClient.get(key);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}
async function redisSetJSON(key, value, ttl) {
    if (!redisClient) return;
    try { await redisClient.set(key, JSON.stringify(value), 'PX', ttl); } catch { }
}

// --- UTILITAIRES ---
function stableStringify(obj) {
    return JSON.stringify(obj, Object.keys(obj).sort());
}

function createCacheKey(config) {
    const minimal = {
        provider: config.provider,
        xtreamUrl: config.xtreamUrl,
        xtreamUsername: config.xtreamUsername,
        includeSeries: config.includeSeries !== false 
    };
    return crypto.createHash('md5').update(stableStringify(minimal)).digest('hex');
}

// --- CLASSE PRINCIPALE ---
class M3UEPGAddon {
    constructor(config = {}) {
        this.providerName = config.provider === 'xtream' ? 'xtream' : 'direct';
        this.config = config;
        this.cacheKey = createCacheKey(config);
        this.channels = [];
        this.movies = [];
        this.series = [];
        this.seriesInfoCache = new Map();
        this.epgData = {};
        this.lastUpdate = 0;
        this.log = (msg) => (process.env.DEBUG_MODE === 'true') && console.log(msg);
    }

    async loadFromCache() {
        if (!CACHE_ENABLED) return;
        const cacheKey = 'addon:data:' + this.cacheKey;
        let cached = dataCache.get(cacheKey);
        if (!cached && redisClient) {
            cached = await redisGetJSON(cacheKey);
            if (cached) dataCache.set(cacheKey, cached);
        }
        if (cached) {
            this.channels = cached.channels || [];
            this.movies = cached.movies || [];
            this.series = cached.series || [];
            this.epgData = cached.epgData || {};
            this.lastUpdate = cached.lastUpdate || 0;
        }
    }

    async saveToCache() {
        if (!CACHE_ENABLED) return;
        const cacheKey = 'addon:data:' + this.cacheKey;
        const entry = { channels: this.channels, movies: this.movies, series: this.series, epgData: this.epgData, lastUpdate: this.lastUpdate };
        dataCache.set(cacheKey, entry);
        await redisSetJSON(cacheKey, entry, CACHE_TTL_MS);
    }

    async updateData(force = false) {
        const now = Date.now();
        if (!force && CACHE_ENABLED && this.lastUpdate && now - this.lastUpdate < 900000) return;
        try {
            const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
            await providerModule.fetchData(this);
            this.lastUpdate = Date.now();
            if (CACHE_ENABLED) await this.saveToCache();
        } catch (e) { console.error('[UPDATE] Failed:', e.message); }
    }

    // --- METADONNÉES (VERSION TMDB HD RESTAURÉE) ---
    generateMetaPreview(item) {
        const meta = { id: item.id, type: item.type, name: item.name };
        let image = item.cover || item.stream_icon || item.logo || item.attributes?.['tvg-logo'] || item.poster;

        if (image && typeof image === 'string') {
            const encodedUrl = encodeURIComponent(image);
            if (item.type === 'tv') {
                image = `https://images.weserv.nl/?url=${encodedUrl}&w=400&h=225&fit=contain&bg=black`;
                meta.posterShape = 'landscape';
            } else {
                image = `https://images.weserv.nl/?url=${encodedUrl}&w=600&fit=contain&bg=black`;
                meta.posterShape = 'poster';
            }
        }

        meta.poster = image || `https://via.placeholder.com/300x450/1a1a1a/ffffff?text=${encodeURIComponent(item.name)}`;
        meta.background = meta.poster;

        if (item.type === 'tv') {
            const epgId = item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'];
            const current = this.getCurrentProgram(epgId);
            meta.description = current ? `📺 En direct: ${current.title}` : '📺 Chaîne TV en direct';
        } else {
            meta.description = item.plot || "Cliquez pour plus d'infos...";
            if (item.type === 'movie') meta.year = item.year || (item.name.match(/\((\d{4})\)/)?.[1]);
        }
        return meta;
    }

    async getDetailedMetaAsync(id, type) {
        const item = [...this.movies, ...this.series, ...this.channels].find(i => i.id === id);
        if (!item) return null;

        const cacheKey = `meta_full_${type}_${item.tmdb_id || item.imdb_id || id}`;
        const cached = dataCache.get(cacheKey);
        if (cached) return cached;

        let meta = this.generateMetaPreview(item);
        const tmdbKey = this.config.tmdbKey ? this.config.tmdbKey.trim() : null;

        // Enrichissement TMDB pour Films et Séries
        if ((item.tmdb_id || item.imdb_id) && tmdbKey && type !== 'tv') {
            try {
                const tmdbType = type === 'series' ? 'tv' : 'movie';
                const searchId = item.tmdb_id || item.imdb_id;
                const url = `https://api.themoviedb.org/3/${tmdbType}/${searchId}?api_key=${tmdbKey}&language=fr-FR&append_to_response=images,videos`;
                const res = await fetch(url);
                if (res.ok) {
                    const data = await res.json();
                    meta.description = data.overview || meta.description;
                    meta.releaseInfo = (data.release_date || data.first_air_date || "").split('-')[0];
                    meta.imdbRating = data.vote_average ? data.vote_average.toFixed(1) : null;
                    meta.genres = data.genres?.map(g => g.name) || [];
                    meta.background = data.backdrop_path ? `https://image.tmdb.org/t/p/original${data.backdrop_path}` : meta.background;
                    meta.poster = data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : meta.poster;
                    if (data.images?.logos?.length > 0) {
                        const logo = data.images.logos.find(l => l.iso_639_1 === 'fr') || data.images.logos[0];
                        meta.logo = `https://image.tmdb.org/t/p/w500${logo.file_path}`;
                    }
                    if (data.videos?.results) {
                        const tr = data.videos.results.find(v => v.type === 'Trailer' && v.site === 'YouTube');
                        if (tr) meta.trailers = [{ source: tr.key, type: 'Trailer' }];
                    }
                }
            } catch (e) { }
        }

        // Gestion des épisodes pour les séries
        if (type === 'series') {
            const seriesIdRaw = item.series_id || id.replace(/^iptv_series_/, '');
            const info = await this.ensureSeriesInfo(seriesIdRaw);
            if (info?.videos) {
                meta.videos = info.videos.map(v => ({
                    id: v.id, title: v.title, season: v.season, episode: v.episode,
                    released: v.released, thumbnail: v.thumbnail || meta.poster
                }));
            }
        }

        dataCache.set(cacheKey, meta);
        return meta;
    }

    // --- EPG & STREAMS ---
    getCurrentProgram(channelId) {
        if (!channelId || !this.epgData[channelId]) return null;
        const now = new Date();
        for (const p of this.epgData[channelId]) {
            const start = this.parseEPGTime(p.start);
            const stop = this.parseEPGTime(p.stop);
            if (now >= start && now <= stop) return { title: p.title };
        }
        return null;
    }

    parseEPGTime(s) {
        if (!s) return new Date();
        const m = s.match(/^(\d{14})/);
        if (m) {
            const b = m[1];
            return new Date(b.slice(0, 4), b.slice(4, 6) - 1, b.slice(6, 8), b.slice(8, 10), b.slice(10, 12), b.slice(12, 14));
        }
        return new Date(s);
    }

    async ensureSeriesInfo(seriesId) {
        if (!seriesId) return null;
        if (this.seriesInfoCache.has(seriesId)) return this.seriesInfoCache.get(seriesId);
        try {
            const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
            const info = await providerModule.fetchSeriesInfo(this, seriesId);
            this.seriesInfoCache.set(seriesId, info);
            return info;
        } catch (e) { return { videos: [] }; }
    }

    getStream(id) {
        if (id.startsWith('iptv_series_ep_')) {
            const epEntry = this.lookupEpisodeById(id);
            return epEntry ? { url: epEntry.url, title: epEntry.title, behaviorHints: { notWebReady: true } } : null;
        }
        const item = [...this.channels, ...this.movies].find(i => i.id === id);
        return item ? { url: item.url, title: item.name, behaviorHints: { notWebReady: true } } : null;
    }

    lookupEpisodeById(epId) {
        for (const [, info] of this.seriesInfoCache.entries()) {
            if (info?.videos) {
                const found = info.videos.find(v => v.id === epId);
                if (found) return found;
            }
        }
        return null;
    }
}

// --- INITIALISATION ADDON (RESTAURATION DE LA LOGIQUE DE FILTRAGE) ---
async function createAddon(config) {
    const dynamicName = config.addonName ? decodeURIComponent(config.addonName) : ADDON_NAME;
    const cleanAddonName = config.addonName ? decodeURIComponent(config.addonName) : "IPTV";
    const safeName = cleanAddonName.replace(/[^a-zA-Z0-9]/g, '');
    const uniqueId = `${ADDON_ID}.${safeName}`;
    const prefix = `${safeName}_`; 

    const addonInstance = new M3UEPGAddon(config);
    await addonInstance.loadFromCache();
    await addonInstance.updateData(true);

    const blacklist = config.blacklisted_cats || [];
    
    const getUniqueCats = (items) => {
        const cats = [...new Set(items.map(i => i.category || i.attributes?.['group-title']).filter(Boolean))];
        return cats.filter(cat => !blacklist.includes(cat)).sort();
    };

    const manifest = {
        id: uniqueId, 
        version: "2.9.0", 
        name: dynamicName,
        resources: ["catalog", "stream", "meta"],
        types: ["tv", "movie", "series"],
        catalogs: [
            // 1. RAILS FAVORIS (HOME)
            ...(config.home_tvs_list ? config.home_tvs_list.map((cat, i) => ({ type: 'tv', id: `${prefix}home_tv_${i}`, name: `📺 ${cat}`, posterShape: 'landscape' })) : []),
            ...(config.home_movies_list ? config.home_movies_list.map((cat, i) => ({ type: 'movie', id: `${prefix}home_movie_${i}`, name: `🎬 ${cat}` })) : []),
            ...(config.home_series_list ? config.home_series_list.map((cat, i) => ({ type: 'series', id: `${prefix}home_series_${i}`, name: `🎞️ ${cat}` })) : []),
            
            // 2. CATALOGUES GLOBAUX
            { type: 'tv', id: `${prefix}channels`, name: `${cleanAddonName} Live`, extra: [{name:'genre'}, {name:'search'}], genres: getUniqueCats(addonInstance.channels), posterShape: 'landscape' },
            { type: 'movie', id: `${prefix}movies`, name: `${cleanAddonName} Movies`, extra: [{name:'genre'}, {name:'search'}], genres: getUniqueCats(addonInstance.movies) },
            { type: 'series', id: `${prefix}series`, name: `${cleanAddonName} Series`, extra: [{name:'genre'}, {name:'search'}], genres: getUniqueCats(addonInstance.series) }
        ],
        idPrefixes: [prefix, "iptv_", "tt", "tmdb:"]
    };

    const builder = new addonBuilder(manifest);

    builder.defineCatalogHandler(async (args) => {
        let items = [];
        const bList = config.blacklisted_cats || [];

        // Gestion des IDs de catalogues (Favoris vs Globaux)
        if (args.id.includes('home_tv_')) {
            const cat = config.home_tvs_list[parseInt(args.id.split('_').pop())];
            items = addonInstance.channels.filter(i => (i.category === cat || i.attributes?.['group-title'] === cat));
        } 
        else if (args.id.includes('home_movie_')) {
            const cat = config.home_movies_list[parseInt(args.id.split('_').pop())];
            items = addonInstance.movies.filter(i => (i.category === cat || i.attributes?.['group-title'] === cat));
        }
        else if (args.id.includes('home_series_')) {
            const cat = config.home_series_list[parseInt(args.id.split('_').pop())];
            items = addonInstance.series.filter(i => (i.category === cat || i.attributes?.['group-title'] === cat));
        }
        else {
            if (args.type === 'tv') items = addonInstance.channels;
            else if (args.type === 'movie') items = addonInstance.movies;
            else if (args.type === 'series') items = addonInstance.series;
            
            // Filtrage Blacklist uniquement sur les catalogues globaux
            items = items.filter(i => !bList.includes(i.category || i.attributes?.['group-title']));
        }

        // Filtres Supplémentaires (Genre / Recherche)
        if (args.extra?.genre) {
            items = items.filter(i => (i.category === args.extra.genre || i.attributes?.['group-title'] === args.extra.genre));
        }
        if (args.extra?.search) {
            const q = args.extra.search.toLowerCase();
            items = items.filter(i => i.name.toLowerCase().includes(q));
        }
        if (args.type !== 'tv') {
            items.sort((a, b) => (b.year || 0) - (a.year || 0));
        }
        return { metas: items.slice(0, 100).map(i => addonInstance.generateMetaPreview(i)) };
    });

builder.defineStreamHandler(async ({ type, id }) => {
    let item = null;

    // 1. SI L'ID EST IMDB (ex: tt123456)
    if (id.startsWith('tt')) {
        const cleanId = id.replace(/\D/g, ''); // On ne garde que les chiffres
        item = [...addonInstance.movies, ...addonInstance.series].find(i => {
            const providerImdb = i.imdb_id ? i.imdb_id.toString().replace(/\D/g, '') : null;
            return providerImdb === cleanId;
        });
    } 
    
    // 2. SI L'ID EST TMDB (ex: tmdb:98765)
    else if (id.startsWith('tmdb:')) {
        const tmdbId = id.split(':')[1];
        item = [...addonInstance.movies, ...addonInstance.series].find(i => {
            return i.tmdb_id && i.tmdb_id.toString() === tmdbId.toString();
        });
    }

    // 3. SI C'EST TON ID INTERNE (clic depuis ton catalogue)
    else {
        const stream = addonInstance.getStream(id);
        if (stream) return { streams: [stream] };
    }

    // SI UN MATCH EST TROUVÉ
    if (item) {
        return {
            streams: [{
                url: item.url,
                title: `📺 Lien IPTV : ${item.name}`,
                behaviorHints: { 
                    notWebReady: true,
                    proxyHeaders: { "User-Agent": "Mozilla/5.0" }
                }
            }]
        };
    }

    return { streams: [] };
});
    builder.defineMetaHandler(async ({ type, id }) => ({ meta: await addonInstance.getDetailedMetaAsync(id, type) }));

    return builder.getInterface();
}

module.exports = createAddon;