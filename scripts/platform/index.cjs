const platforms = new Map([
    ["linux", require("./linux.cjs")],
    ["darwin", require("./macos.cjs")],
    ["win32", require("./windows.cjs")],
]);

module.exports = platforms.get(process.platform) ?? require("./posix.cjs");
