const path = require("path");
const svgrConfig = require("./svgr.config.js");

const src = path.resolve(__dirname, "../src");

module.exports = {
  babel: {
    loaderOptions: (options) => {
      const presets = options.presets || [];
      options.presets = presets.map((preset) => {
        const name = Array.isArray(preset) ? preset[0] : preset;
        const opts = Array.isArray(preset) ? preset[1] || {} : {};
        if (
          typeof name === "string" &&
          name.includes("babel-preset-react-app")
        ) {
          return [
            name,
            { ...opts, runtime: "automatic", throwIfNamespace: false },
          ];
        }
        return preset;
      });
      return options;
    },
  },
  webpack: {
    alias: {
      "@": src,
      "@auth": path.join(src, "Components/Portal/Auth"),
      "@images": path.join(src, "Assets/Images"),
      "@vectors": path.join(src, "Assets/Vectors"),
      "@tabs": path.join(src, "Components/Portal/Tabs"),
      "@portal": path.join(src, "Components/Portal"),
      "@landing": path.join(src, "Components/Landing"),
    },
    configure: (webpackConfig) => {
      webpackConfig.module.rules.forEach((rule) => {
        if (rule.oneOf) {
          rule.oneOf.forEach((loader) => {
            if (loader.loader && loader.loader.includes("@svgr/webpack")) {
              loader.options = {
                ...loader.options,
                ...svgrConfig,
                throwIfNamespace: false,
              };
            }
          });
        }
      });
      return webpackConfig;
    },
  },
};
