const { stopProcess: stopPosixProcess } = require("./posix.cjs");
const { stopProcess: stopWindowsProcess } = require("./windows.cjs");

module.exports = {
    stopProcess: process.platform === "win32" ? stopWindowsProcess : stopPosixProcess,
};
