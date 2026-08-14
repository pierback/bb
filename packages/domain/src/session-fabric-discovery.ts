import { z } from "zod";
import { sessionCapabilityEvidenceSchema } from "./session-fabric-control.js";
import { nativeConversationRefSchema } from "./session-fabric-identity.js";

export const sessionDiscoveryMethodValues = [
  "provider_api",
  "provider_sdk",
  "native_store",
  "acp_session_list",
] as const;
export const sessionDiscoveryMethodSchema = z.enum(
  sessionDiscoveryMethodValues,
);
export type SessionDiscoveryMethod = z.infer<
  typeof sessionDiscoveryMethodSchema
>;

export const sessionDiscoveryConfidenceValues = [
  "provider_authoritative",
  "provider_declared",
  "native_store_parsed",
] as const;
export const sessionDiscoveryConfidenceSchema = z.enum(
  sessionDiscoveryConfidenceValues,
);
export type SessionDiscoveryConfidence = z.infer<
  typeof sessionDiscoveryConfidenceSchema
>;

/**
 * Evidence for a read-only catalog observation. It deliberately carries no
 * process identity: discovery cannot prove which runtime, if any, controls a
 * persisted native conversation.
 */
export const sessionDiscoveryEvidenceSchema = z
  .object({
    confidence: sessionDiscoveryConfidenceSchema,
    method: sessionDiscoveryMethodSchema,
    observedAt: z.number().int().nonnegative(),
    parserVersion: z.number().int().positive(),
    providerVersion: z.string().min(1).nullable(),
    source: z.string().min(1),
  })
  .strict();
export type SessionDiscoveryEvidence = z.infer<
  typeof sessionDiscoveryEvidenceSchema
>;

export const discoveredNativeConversationStateValues = [
  "persisted_only",
  "provider_reported_idle",
  "provider_reported_active",
  "provider_reported_error",
  "unknown",
] as const;
export const discoveredNativeConversationStateSchema = z.enum(
  discoveredNativeConversationStateValues,
);
export type DiscoveredNativeConversationState = z.infer<
  typeof discoveredNativeConversationStateSchema
>;

export const discoveryProjectMatchBasisValues = [
  "exact_cwd",
  "cwd_descendant",
  "unmapped",
] as const;
export const discoveryProjectMatchBasisSchema = z.enum(
  discoveryProjectMatchBasisValues,
);
export type DiscoveryProjectMatchBasis = z.infer<
  typeof discoveryProjectMatchBasisSchema
>;

export const discoveryProjectAssociationSchema = z
  .object({
    basis: discoveryProjectMatchBasisSchema,
    confidence: z.enum(["exact", "high", "none"]),
    projectRootPath: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((association, context) => {
    const isMapped = association.basis !== "unmapped";
    if (isMapped !== (association.projectRootPath !== null)) {
      context.addIssue({
        code: "custom",
        message: "mapped project associations must name a project root",
        path: ["projectRootPath"],
      });
    }
    if (
      (association.basis === "exact_cwd") !==
      (association.confidence === "exact")
    ) {
      context.addIssue({
        code: "custom",
        message: "only exact cwd matches have exact confidence",
        path: ["confidence"],
      });
    }
    if (
      (association.basis === "unmapped") !==
      (association.confidence === "none")
    ) {
      context.addIssue({
        code: "custom",
        message: "unmapped project associations must have no confidence",
        path: ["confidence"],
      });
    }
  });
export type DiscoveryProjectAssociation = z.infer<
  typeof discoveryProjectAssociationSchema
>;

/**
 * Provider-native catalog metadata. Transcript bodies, prompts, tool output,
 * credentials, and process handles are intentionally absent.
 */
export const discoveredNativeConversationSchema = z
  .object({
    archived: z.boolean().nullable(),
    createdAt: z.number().int().nonnegative().nullable(),
    displayTitle: z.string().min(1).nullable(),
    evidence: sessionDiscoveryEvidenceSchema,
    nativeConversation: nativeConversationRefSchema,
    ownership: z.literal("unfenced_external"),
    project: discoveryProjectAssociationSchema.nullable(),
    providerState: discoveredNativeConversationStateSchema,
    reportedCwd: z.string().min(1).nullable(),
    transcriptContentIncluded: z.literal(false),
    updatedAt: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type DiscoveredNativeConversation = z.infer<
  typeof discoveredNativeConversationSchema
>;

export const providerSessionDiscoveryAvailabilityValues = [
  "supported",
  "unsupported",
  "unavailable",
] as const;
export const providerSessionDiscoveryAvailabilitySchema = z.enum(
  providerSessionDiscoveryAvailabilityValues,
);
export type ProviderSessionDiscoveryAvailability = z.infer<
  typeof providerSessionDiscoveryAvailabilitySchema
>;

export const providerSessionDiscoveryScanSchema = z
  .object({
    availability: providerSessionDiscoveryAvailabilitySchema,
    capability: sessionCapabilityEvidenceSchema.nullable(),
    conversations: z.array(discoveredNativeConversationSchema),
    detailCode: z.string().min(1),
    nextCursor: z.string().min(1).nullable(),
    observedAt: z.number().int().nonnegative(),
    providerId: z.string().min(1),
    providerInstanceId: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict()
  .superRefine((scan, context) => {
    if (scan.availability === "supported") {
      if (scan.capability === null) {
        context.addIssue({
          code: "custom",
          message: "supported discovery must carry capability evidence",
          path: ["capability"],
        });
      }
      if (scan.capability !== null) {
        if (scan.capability.kind !== "discover") {
          context.addIssue({
            code: "custom",
            message: "discovery capability evidence must have discover kind",
            path: ["capability", "kind"],
          });
        }
        if (scan.capability.authority !== "read_only") {
          context.addIssue({
            code: "custom",
            message: "discovery capability evidence must be read-only",
            path: ["capability", "authority"],
          });
        }
      }
      return;
    }

    if (scan.capability !== null) {
      context.addIssue({
        code: "custom",
        message: "unsupported or unavailable discovery has no capability",
        path: ["capability"],
      });
    }
    if (scan.conversations.length > 0) {
      context.addIssue({
        code: "custom",
        message: "unsupported or unavailable discovery has no records",
        path: ["conversations"],
      });
    }
    if (scan.nextCursor !== null) {
      context.addIssue({
        code: "custom",
        message: "unsupported or unavailable discovery has no cursor",
        path: ["nextCursor"],
      });
    }
  });
export type ProviderSessionDiscoveryScan = z.infer<
  typeof providerSessionDiscoveryScanSchema
>;
