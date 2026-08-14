import { z } from "zod";
import {
  bbDesktopUpdateChannelSchema,
  type BbDesktopUpdateChannel,
} from "./info.js";

export const PIERBACK_DESKTOP_UPDATE_CHANNEL_FILE_NAME =
  "desktop-update-channel.json";

export const pierbackDesktopUpdateChannelPreferenceSchema = z
  .object({
    channel: bbDesktopUpdateChannelSchema,
    schemaVersion: z.literal(1),
  })
  .strict();

export type PierbackDesktopUpdateChannelPreference = z.infer<
  typeof pierbackDesktopUpdateChannelPreferenceSchema
>;

export function parsePierbackDesktopUpdateChannelPreference(
  raw: string,
): BbDesktopUpdateChannel {
  const payload: unknown = JSON.parse(raw);
  return pierbackDesktopUpdateChannelPreferenceSchema.parse(payload).channel;
}

export function serializePierbackDesktopUpdateChannelPreference(
  channel: BbDesktopUpdateChannel,
): string {
  return `${JSON.stringify(
    pierbackDesktopUpdateChannelPreferenceSchema.parse({
      channel,
      schemaVersion: 1,
    }),
    null,
    2,
  )}\n`;
}
