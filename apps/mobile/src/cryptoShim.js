/** Metro shim: @noble/hashes expects WebCrypto on `exports./crypto`. */
const c =
  typeof globalThis !== "undefined" && globalThis.crypto
    ? globalThis.crypto
    : undefined;

module.exports = c;
module.exports.crypto = c;
module.exports.default = c;
