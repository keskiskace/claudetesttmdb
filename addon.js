// IPTV Stremio Addon Core
require('dotenv').config();

const { addonBuilder } = require("stremio-addon-sdk");
const crypto = require("crypto");
const LRUCache = require("./lruCache");
const fetch = require('node-fetch');

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
        console.warn('[REDIS] ioredis not installed or failed, falling back to in-memory LRU');
        redisClient = null;
    }
}

const ADDON_NAME = "PTV V5";
const ADDON_ID = "fr.keskiskace.iptv-perso-ve8";

const DEBUG_ENV = (process.env.DEBUG_MODE || '').toLowerCase() === 'true';
function makeLogger(cfgDebug) {
    const enabled = !!cfgDebug || DEBUG_ENV;
    return {
        debug: (...a) => { if (enabled) console.log('[DEBUG]', ...a); },
        info:  (...a) => console.log('[INFO]', ...a),
        warn:  (...a) => console.warn('[WARN]', ...a),
        error: (...a) => console.error('[ERROR]', ...a)
    };
}

const CACHE_ENABLED = (process.env.CACHE_ENABLED || 'true').toLowerCase() !== 'false';
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || (6 * 3600 * 1000).toString(), 10);
const MAX_CACHE_ENTRIES = parseInt(process.env.MAX_CACHE_ENTRIES || '300', 10);

const dataCache = new LRUCache({ max: MAX_CACHE_ENTRIES, ttl: CACHE_TTL_MS });
const buildPromiseCache = new Map();

async function redisGetJSON(key) {
    if (!redisClient) return null;
    try {
        const raw = await redisClient.get(key);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch { return null; }
}
async function redisSetJSON(key, value, ttl) {
    if (!redisClient) return;
    try {
        await redisClient.set(key, JSON.stringify(value), 'PX', ttl);
    } catch { /* ignore */ }
}

function stableStringify(obj) {
    return JSON.stringify(obj, Object.keys(obj).sort());
}

function createCacheKey(config) {
    const minimal = {
        provider: config.provider,
        m3uUrl: config.m3uUrl,
        epgUrl: config.epgUrl,
        enableEpg: !!config.enableEpg,
        xtreamUrl: config.xtreamUrl,
        xtreamUsername: config.xtreamUsername,
        xtreamUseM3U: !!config.xtreamUseM3U,
        xtreamOutput: config.xtreamOutput,
        epgOffsetHours: config.epgOffsetHours,
        includeSeries: config.includeSeries !== false 
    };
    return crypto.createHash('md5').update(stableStringify(minimal)).digest('hex');
}

class M3UEPGAddon {
    constructor(config = {}, manifestRef) {
        if (!config.provider) {
            config.provider = config.useXtream ? 'xtream' : 'direct';
        }
        this.providerName = config.provider === 'xtream' ? 'xtream' : 'direct';
        this.config = config;
        this.manifestRef = manifestRef;
        this.cacheKey = createCacheKey(config);
        this.updateInterval = 3600000;
        this.channels = [];
        this.movies = [];
        this.series = [];
        this.categories = { lives: [], movies: [], series: [] };
        this.seriesInfoCache = new Map();
        this.epgData = {};
        this.lastUpdate = 0;
        this.log = makeLogger(config.debug);
        this.directSeriesEpisodeIndex = new Map();

        if (typeof this.config.epgOffsetHours === 'string') {
            const n = parseFloat(this.config.epgOffsetHours);
            if (!isNaN(n)) this.config.epgOffsetHours = n;
        }
        if (typeof this.config.epgOffsetHours !== 'number' || !isFinite(this.config.epgOffsetHours))
            this.config.epgOffsetHours = 0;
        if (Math.abs(this.config.epgOffsetHours) > 48)
            this.config.epgOffsetHours = 0;
        if (typeof this.config.includeSeries === 'undefined')
            this.config.includeSeries = true;
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
        const entry = {
            channels: this.channels,
            movies: this.movies,
            series: this.series,
            epgData: this.epgData,
            lastUpdate: this.lastUpdate
        };
        dataCache.set(cacheKey, entry);
        await redisSetJSON(cacheKey, entry, CACHE_TTL_MS);
    }

    buildGenresInManifest() { return; }

    parseM3U(content) {
        const lines = content.split('\n');
        const items = [];
        let currentItem = null;
        for (const raw of lines) {
            const line = raw.trim();
            if (line.startsWith('#EXTINF:')) {
                const matches = line.match(/#EXTINF:(-?\d+)(?:\s+(.*))?,(.*)/);
                if (matches) {
                    currentItem = {
                        duration: parseInt(matches[1]),
                        attributes: this.parseAttributes(matches[2] || ''),
                        name: (matches[3] || '').trim()
                    };
                }
            } else if (line && !line.startsWith('#') && currentItem) {
                currentItem.url = line;
                currentItem.logo = currentItem.attributes['tvg-logo'];
                currentItem.epg_channel_id = currentItem.attributes['tvg-id'] || currentItem.attributes['tvg-name'];
                currentItem.category = currentItem.attributes['group-title'];
                const group = (currentItem.attributes['group-title'] || '').toLowerCase();
                const lower = currentItem.name.toLowerCase();
                const isMovie = group.includes('movie') || lower.includes('movie') || this.isMovieFormat(currentItem.name);
                const isSeries = !isMovie && (group.includes('series') || group.includes('show') || /\bS\d{1,2}E\d{1,2}\b/i.test(currentItem.name) || /\bSeason\s?\d+/i.test(currentItem.name));
                currentItem.type = isSeries ? 'series' : (isMovie ? 'movie' : 'tv');
                currentItem.id = `iptv_${crypto.createHash('md5').update(currentItem.name + currentItem.url).digest('hex').substring(0, 16)}`;
                items.push(currentItem);
                currentItem = null;
            }
        }
        return items;
    }

    parseAttributes(str) {
        const attrs = {};
        const regex = /(\w+(?:-\w+)*)="([^"]*)"/g;
        let m;
        while ((m = regex.exec(str)) !== null) attrs[m[1]] = m[2];
        return attrs;
    }

    isMovieFormat(name) {
        return [/\(\d{4}\)/, /\d{4}\./, /HD$|FHD$|4K$/i].some(p => p.test(name));
    }

    async parseEPG(content) {
        try {
            const xml2js = require('xml2js');
            const parser = new xml2js.Parser();
            const result = await parser.parseStringPromise(content);
            const epgData = {};
            if (result.tv && result.tv.programme) {
                for (const prog of result.tv.programme) {
                    const ch = prog.$.channel;
                    if (!epgData[ch]) epgData[ch] = [];
                    epgData[ch].push({
                        start: prog.$.start,
                        stop: prog.$.stop,
                        title: prog.title ? prog.title[0]._ || prog.title[0] : 'Unknown',
                        desc: prog.desc ? prog.desc[0]._ || prog.desc[0] : ''
                    });
                }
            }
            return epgData;
        } catch (e) { return {}; }
    }

    parseEPGTime(s) {
        if (!s) return new Date();
        const m = s.match(/^(\d{14})(?:\s*([+\-]\d{4}))?/);
        if (m) {
            const base = m[1];
            const tz = m[2] || null;
            const year = parseInt(base.slice(0, 4), 10);
            const month = parseInt(base.slice(4, 6), 10) - 1;
            const day = parseInt(base.slice(6, 8), 10);
            const hour = parseInt(base.slice(8, 10), 10);
            const min = parseInt(base.slice(10, 12), 10);
            const sec = parseInt(base.slice(12, 14), 10);
            let date;
            if (tz) {
                const iso = `${year}-${(month + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}T${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}${tz}`;
                const parsed = new Date(iso);
                if (!isNaN(parsed.getTime())) date = parsed;
            }
            if (!date) date = new Date(year, month, day, hour, min, sec);
            if (this.config.epgOffsetHours) date = new Date(date.getTime() + this.config.epgOffsetHours * 3600000);
            return date;
        }
        return new Date(s);
    }

    getCurrentProgram(channelId) {
        if (!channelId || !this.epgData[channelId]) return null;
        const now = new Date();
        for (const p of this.epgData[channelId]) {
            const start = this.parseEPGTime(p.start);
            const stop = this.parseEPGTime(p.stop);
            if (now >= start && now <= stop) return { title: p.title, description: p.desc, startTime: start, stopTime: stop };
        }
        return null;
    }

    getUpcomingPrograms(channelId, limit = 5) {
        if (!channelId || !this.epgData[channelId]) return [];
        const now = new Date();
        const upcoming = [];
        for (const p of this.epgData[channelId]) {
            const start = this.parseEPGTime(p.start);
            if (start > now && upcoming.length < limit) {
                upcoming.push({ title: p.title, description: p.desc, startTime: start, stopTime: this.parseEPGTime(p.stop) });
            }
        }
        return upcoming.sort((a, b) => a.startTime - b.startTime);
    }

    async ensureSeriesInfo(seriesId) {
        if (!seriesId) return null;
        if (this.seriesInfoCache.has(seriesId)) return this.seriesInfoCache.get(seriesId);
        try {
            const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
            if (typeof providerModule.fetchSeriesInfo === 'function') {
                const info = await providerModule.fetchSeriesInfo(this, seriesId);
                this.seriesInfoCache.set(seriesId, info);
                return info;
            }
        } catch (e) { }
        const empty = { videos: [] };
        this.seriesInfoCache.set(seriesId, empty);
        return empty;
    }

    async updateData(force = false) {
        const now = Date.now();
        if (!force && CACHE_ENABLED && this.lastUpdate && now - this.lastUpdate < 900000) return;
        try {
            const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
            await providerModule.fetchData(this);
            this.lastUpdate = Date.now();
            if (CACHE_ENABLED) await this.saveToCache();
        } catch (e) { this.log.error('[UPDATE] Failed:', e.message); }
    }

    deriveFallbackLogoUrl(item) {
        const logoAttr = item.attributes?.['tvg-logo'] || item.logo || item.stream_icon || item.cover;
        if (logoAttr && logoAttr.trim()) return logoAttr;
        return `https://via.placeholder.com/300x200/333333/FFFFFF?text=${encodeURIComponent(item.name)}`;
    }

generateMetaPreview(item) {
    const meta = { id: item.id, type: item.type, name: item.name };
    let image = item.cover || item.stream_icon || item.logo || item.attributes?.['tvg-logo'] || item.poster;

    if (image && typeof image === 'string') {
        // IMPORTANT : On garde l'URL complète pour Weserv
        const encodedUrl = encodeURIComponent(image);
        
        if (item.type === 'tv') {
            // Anti-zoom TV (16:9)
            image = `https://images.weserv.nl/?url=${encodedUrl}&w=400&h=225&fit=contain&bg=black`;
        } else {
            // Format poster Films/Séries (2:3)
            image = `https://images.weserv.nl/?url=${encodedUrl}&w=300&h=450&fit=contain&bg=black`;
        }
    }

    if (item.type === 'tv') {
        const epgId = item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'];
        const current = this.getCurrentProgram(epgId);
        meta.description = current ? `📺 Now: ${current.title}` : '📺 Live Channel';
        meta.poster = image || this.deriveFallbackLogoUrl(item);
        meta.posterShape = 'landscape'; 
    } else {
        meta.poster = image || `https://via.placeholder.com/300x450/1a1a1a/ffffff?text=${encodeURIComponent(item.name)}`;
        meta.posterShape = 'poster';
        if (item.type === 'movie') {
            meta.year = item.year || (item.name.match(/\((\d{4})\)/)?.[1]);
        }
    }
    
    // On ajoute ça pour aider Stremio à ne pas déformer
    meta.logo = meta.poster;
    meta.background = meta.poster; 

    return meta;
}

    getStream(id) {
        if (id.startsWith('iptv_series_ep_')) {
            const epEntry = this.lookupEpisodeById(id);
            if (!epEntry) return null;
            return { url: epEntry.url, title: epEntry.title || 'Episode', behaviorHints: { notWebReady: true } };
        }
        const all = [...this.channels, ...this.movies];
        const item = all.find(i => i.id === id);
        if (!item) return null;
        return { url: item.url, title: item.name, behaviorHints: { notWebReady: true } };
    }

    lookupEpisodeById(epId) {
        for (const [, info] of this.seriesInfoCache.entries()) {
            if (info && Array.isArray(info.videos)) {
                const found = info.videos.find(v => v.id === epId);
                if (found) return found;
            }
        }
        for (const arr of this.directSeriesEpisodeIndex.values()) {
            const found = arr.find(v => v.id === epId);
            if (found) return found;
        }
        return null;
    }

    async buildSeriesMeta(seriesItem) {
        const seriesIdRaw = seriesItem.series_id || seriesItem.id.replace(/^iptv_series_/, '');
        const info = await this.ensureSeriesInfo(seriesIdRaw);
        const videos = (info?.videos || []).map(v => ({
            id: v.id, title: v.title, season: v.season, episode: v.episode,
            thumbnail: v.thumbnail || seriesItem.poster || seriesItem.attributes?.['tvg-logo']
        }));
        return {
            id: seriesItem.id, type: 'series', name: seriesItem.name,
            poster: seriesItem.poster || seriesItem.attributes?.['tvg-logo'] || seriesItem.logo,
            description: seriesItem.plot || 'Series', videos
        };
    }

    async getDetailedMetaAsync(id, type) {
        if (type === 'series' || id.startsWith('iptv_series_')) {
            const seriesItem = this.series.find(s => s.id === id);
            return seriesItem ? await this.buildSeriesMeta(seriesItem) : null;
        }
        return this.getDetailedMeta(id);
    }

    getDetailedMeta(id) {
        const item = this.channels.find(i => i.id === id) || this.movies.find(i => i.id === id) || this.series.find(i => i.id === id);
        if (!item) return null;
        const image = item.stream_icon || item.cover || item.logo || item.attributes?.['tvg-logo'] || item.poster || this.deriveFallbackLogoUrl(item);
        if (item.type === 'tv') {
            const epgId = item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'];
            const current = this.getCurrentProgram(epgId);
            return { id: item.id, type: 'tv', name: item.name, poster: image, description: current ? `Now: ${current.title}` : item.name, posterShape: 'landscape' };
        } else {
            return { id: item.id, type: 'movie', name: item.name, poster: image, description: item.plot || item.name, posterShape: 'poster' };
        }
    }
}

async function createAddon(config) {
    const dynamicName = config.addonName ? decodeURIComponent(config.addonName) : ADDON_NAME;
    const cleanAddonName = config.addonName ? decodeURIComponent(config.addonName) : "IPTV";
    const safeName = cleanAddonName.replace(/[^a-zA-Z0-9]/g, '');
    const uniqueId = `${ADDON_ID}.${safeName}`;
    const prefix = `${safeName}_`; 

    const addonInstance = new M3UEPGAddon(config, null);
    await addonInstance.loadFromCache();
    await addonInstance.updateData(true);

    // --- LOGIQUE DE FILTRAGE (RESTAURÉE) ---
    const blacklist = config.blacklisted_cats || [];
    const getUniqueCats = (items) => {
        if (!items || items.length === 0) return [];
        const cats = [...new Set(items.map(i => i.category || i.attributes?.['group-title']).filter(Boolean))];
        // On exclut les catégories blacklistées ici pour le menu "Genre"
        return cats.filter(cat => !blacklist.includes(cat)).sort();
    };

    const manifest = {
        id: uniqueId, 
        version: "2.8.8", 
        name: dynamicName,
        resources: ["catalog", "stream", "meta"],
        types: ["tv", "movie", "series"],
        catalogs: [
            // 1. Les Rails HOME (Favoris)
            ...(config.home_tvs_list ? config.home_tvs_list.map((catName, i) => ({ type: 'tv', id: `${prefix}home_tv_${i}`, name: `📺 ${catName}`, posterShape: 'landscape' })) : []),
            ...(config.home_movies_list ? config.home_movies_list.map((catName, i) => ({ type: 'movie', id: `${prefix}home_movie_${i}`, name: `🎬 ${catName}` })) : []),
            ...(config.home_series_list ? config.home_series_list.map((catName, i) => ({ type: 'series', id: `${prefix}home_series_${i}`, name: `🎞️ ${catName}` })) : []),
            
            // 2. Les Rails GLOBAUX (Avec le nom de ton Addon)
            { 
                type: 'tv', id: `${prefix}channels`, name: `${cleanAddonName} Live`, 
                extra: [{name:'genre'}, {name:'search'}], 
                genres: getUniqueCats(addonInstance.channels), 
                posterShape: 'landscape' 
            },
            { 
                type: 'movie', id: `${prefix}movies`, name: `${cleanAddonName} Movies`, 
                extra: [{name:'genre'}, {name:'search'}], 
                genres: getUniqueCats(addonInstance.movies) 
            },
            { 
                type: 'series', id: `${prefix}series`, name: `${cleanAddonName} Series`, 
                extra: [{name:'genre'}, {name:'search'}], 
                genres: getUniqueCats(addonInstance.series) 
            }
        ],
        idPrefixes: [prefix, "iptv_"]
    };

    const builder = new addonBuilder(manifest);

    builder.defineCatalogHandler(async (args) => {
        let items = [];
        const bList = config.blacklisted_cats || [];

        // Gestion des IDs de catalogues
        if (args.id.includes('home_tv_')) {
            const idx = parseInt(args.id.split('_').pop());
            const cat = config.home_tvs_list[idx];
            items = addonInstance.channels.filter(i => (i.category === cat) || (i.attributes?.['group-title'] === cat));
        } 
        else if (args.id.includes('home_movie_')) {
            const idx = parseInt(args.id.split('_').pop());
            const cat = config.home_movies_list[idx];
            items = addonInstance.movies.filter(i => (i.category === cat) || (i.attributes?.['group-title'] === cat));
        }
        else if (args.id.includes('home_series_')) {
            const idx = parseInt(args.id.split('_').pop());
            const cat = config.home_series_list[idx];
            items = addonInstance.series.filter(i => (i.category === cat) || (i.attributes?.['group-title'] === cat));
        }
        else if (args.type === 'tv') items = addonInstance.channels;
        else if (args.type === 'movie') items = addonInstance.movies;
        else if (args.type === 'series') items = addonInstance.series;

        // --- FILTRE ANTI-LOGS ET BLACKLIST ---
        // On retire tout ce qui est dans la blacklist pour les rails globaux
        if (!args.id.includes('home_')) {
            items = items.filter(i => !bList.includes(i.category || i.attributes?.['group-title']));
        }

        // Filtre par genre (clic dans Découvrir)
        if (args.extra && args.extra.genre) {
            items = items.filter(i => (i.category === args.extra.genre) || (i.attributes?.['group-title'] === args.extra.genre));
        }
        
        // Recherche
        if (args.extra && args.extra.search) {
            const q = args.extra.search.toLowerCase();
            items = items.filter(i => i.name.toLowerCase().includes(q));
        }

        return { metas: items.slice(0, 100).map(i => addonInstance.generateMetaPreview(i)) };
    });

    builder.defineStreamHandler(async ({ id }) => {
        const s = addonInstance.getStream(id);
        return { streams: s ? [s] : [] };
    });

    builder.defineMetaHandler(async ({ type, id }) => {
        const m = await addonInstance.getDetailedMetaAsync(id, type);
        return { meta: m };
    });

    return builder.getInterface();
}

module.exports = createAddon;