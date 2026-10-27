// A browser has TextEncoder and TextDecoder, so the 600 KB polyfill that CopilotKit's React Native
// package brings for phones is left out of the web bundle (see metro.config.js).
module.exports = { TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder };
