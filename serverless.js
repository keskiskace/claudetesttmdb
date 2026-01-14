const { getRouter } = require("stremio-addon-sdk");
const createAddon = require("./addon");

// NOTE: In a serverless environment, cold starts will rebuild & preload every time.
// You may wish to add a timeout guard or skip full preload if execution time is tight.

let cachedInterface = null;
let cachedConfigKey = null;

async function getInterface(eventConfig = {}) {
    const key = JSON.stringify(eventConfig);
    if (cachedInterface && cachedConfigKey === key) {
        return cachedInterface;
    }
    cachedInterface = await createAddon(eventConfig);
    cachedConfigKey = key;
    return cachedInterface;
}

module.exports = async function (req, res) {
    try {
        // This simplistic serverless handler does not parse per-request configs via URL like server.js.
        // If you want dynamic configs in serverless, you'd replicate the logic from server.js here.
        const addonInterface = await getInterface();
        const router = getRouter(addonInterface);
        router(req, res, function () {
            res.statusCode = 404;
            res.end();
        });
    } catch (e) {
        console.error('[SERVERLESS] Error:', e);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'Serverless addon error' }));
    }
};