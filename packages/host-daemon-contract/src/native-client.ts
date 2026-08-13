/**
 * Marks requests made by a native client directly through a self-hosted
 * coordinator gateway. This value is routing metadata, not a credential; the
 * bearer host key remains the authenticated identity.
 */
export const BB_NATIVE_CLIENT_HEADER_NAME = "x-bb-native-client";
export const BB_NATIVE_CLIENT_HEADER_VALUE = "host-key-v1";
