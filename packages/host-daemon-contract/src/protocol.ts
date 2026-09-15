// Version 208 is the BB Mesh hard cutover on top of upstream protocol 207.
// It retains the coordinator/execution split, Session Fabric commands, and
// host-local API routing fields that are not understood by a stock daemon.
export const HOST_DAEMON_PROTOCOL_VERSION = 208 as const;

export const HOST_ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;
