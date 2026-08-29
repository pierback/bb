import { z } from "zod";
import {
  bbDesktopUpdateChannelSchema,
  type BbDesktopUpdateChannel,
} from "./info.js";

export const BB_MESH_DESKTOP_UPDATE_CHANNEL_FILE_NAME =
  "desktop-update-channel.json";

export const bbMeshDesktopUpdateChannelPreferenceSchema = z
  .object({
    channel: bbDesktopUpdateChannelSchema,
    schemaVersion: z.literal(1),
  })
  .strict();

export type BbMeshDesktopUpdateChannelPreference = z.infer<
  typeof bbMeshDesktopUpdateChannelPreferenceSchema
>;

export function parseBbMeshDesktopUpdateChannelPreference(
  raw: string,
): BbDesktopUpdateChannel {
  const payload: unknown = JSON.parse(raw);
  return bbMeshDesktopUpdateChannelPreferenceSchema.parse(payload).channel;
}

export function serializeBbMeshDesktopUpdateChannelPreference(
  channel: BbDesktopUpdateChannel,
): string {
  return `${JSON.stringify(
    bbMeshDesktopUpdateChannelPreferenceSchema.parse({
      channel,
      schemaVersion: 1,
    }),
    null,
    2,
  )}\n`;
}
