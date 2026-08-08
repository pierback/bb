import { customAlphabet } from "nanoid";

const PRETTY_ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
const PRETTY_ID_SUFFIX_LENGTH = 10;

const generatePrettyIdSuffix = customAlphabet(
  PRETTY_ID_ALPHABET,
  PRETTY_ID_SUFFIX_LENGTH,
);

function createId(prefix: string): string {
  return `${prefix}_${generatePrettyIdSuffix()}`;
}

export function createHostId(): string {
  return createId("host");
}

export function createProjectId(): string {
  return createId("proj");
}

export function createProjectSourceId(): string {
  return createId("src");
}

export function createEnvironmentId(): string {
  return createId("env");
}

export function createEnvironmentProvisioningId(): string {
  return createId("epv");
}

export function createThreadId(): string {
  return createId("thr");
}

export function createThreadSectionId(): string {
  return createId("sec");
}

export function createThreadProvisioningId(): string {
  return createId("tpv");
}

export function createEventId(): string {
  return createId("evt");
}

export function createPromptHistoryEntryId(): string {
  return createId("phist");
}

export function createQueuedThreadMessageId(): string {
  return createId("qmsg");
}

export function createQueuedThreadMessageClaimToken(): string {
  return createId("qclaim");
}

export function createPendingInteractionId(): string {
  return createId("pint");
}

export function createHostDaemonSessionId(): string {
  return createId("hses");
}

export function createTerminalSessionId(): string {
  return createId("term");
}

export function createSessionWorkstreamId(): string {
  return createId("swk");
}

export function createSessionBranchId(): string {
  return createId("sbr");
}

export function createSessionNativeConversationId(): string {
  return createId("snc");
}

export function createSessionRuntimeInstanceId(): string {
  return createId("sri");
}

export function createSessionRuntimeRecipeId(): string {
  return createId("srr");
}

export function createSessionWorkspaceStateId(): string {
  return createId("sws");
}

export function createSessionExecutionBindingId(): string {
  return createId("seb");
}

export function createSessionAdoptionId(): string {
  return createId("sad");
}

export function createSessionModelEpochId(): string {
  return createId("sme");
}

export function createSessionCommandId(): string {
  return createId("scm");
}

export function createSessionCommandEventId(): string {
  return createId("sce");
}

export function createSessionHandoffTransitionId(): string {
  return createId("sht");
}

export function createSessionHandoffEventId(): string {
  return createId("she");
}

export function createSessionHandoffSettlementId(): string {
  return createId("shs");
}

export function createSessionContextCapsuleId(): string {
  return createId("scc");
}

export function createSessionHandoffReviewId(): string {
  return createId("shr");
}

export function createSessionHandoffAuthorizationId(): string {
  return createId("sha");
}

export function createSessionHandoffRestatementId(): string {
  return createId("shrt");
}
