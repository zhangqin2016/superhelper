import officeCli from "./lib/windows-office-cli.cjs";
const { officeInfoCommand } = officeCli;

// LibreOffice's GUI launcher allocates an interactive console for --version.
// Its sibling CLI has the same informational output without waiting for Enter.
// Only rewrite a literal, leading informational invocation; never user scripts,
// document printing, conversions, compound prefixes or dynamic executable paths.

export const WindowsOfficeCliPlugin = async () => ({
  "tool.execute.before": async (input, output) => {
    if (input?.tool !== "bash" || !output?.args) return;
    output.args.command = officeInfoCommand(output.args.command);
  },
});

export default WindowsOfficeCliPlugin;
