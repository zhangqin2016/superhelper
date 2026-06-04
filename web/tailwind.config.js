module.exports = {
  content: ["./app/**/*.{js,jsx}", "./components/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#080A0D",
        panel: "#11161C",
        raised: "#171D25",
        line: "#26313D",
        muted: "#9AA4B2",
        brand: "#1F7A8C",
        cyan: "#4CC9F0",
        mint: "#5FF1C4",
        coral: "#FF6B4A",
      },
      fontFamily: {
        sans: ["Inter", "Geist", "system-ui", "PingFang SC", "Microsoft YaHei", "sans-serif"],
        mono: ["JetBrains Mono", "Geist Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
    },
  },
  plugins: [],
};
