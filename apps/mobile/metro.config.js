const { getDefaultConfig } = require("expo/metro-config");
const config = getDefaultConfig(__dirname);
const path = require("node:path");
config.watchFolders = [path.resolve(__dirname, "../..")];
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === "web" && moduleName === "text-encoding")
    return { type: "sourceFile", filePath: path.resolve(__dirname, "web-text-encoding.js") };
  if (moduleName === "jose" || moduleName.startsWith("jose/")) {
    return context.resolveRequest(
      { ...context, unstable_conditionNames: ["browser", "require", "import"] },
      moduleName,
      platform,
    );
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};
module.exports = config;
