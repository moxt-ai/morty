// This target holds no tables. Its committed migrations stay because the pairing target's history reads a table they
// create before moving it, so every ComputerRelay applies them first.
export {};
