import {
  createNodeBbSdk,
  type BbSdkContext,
  type NodeBbSdk,
} from "@bb/sdk/node";

export interface CreateCliBbSdkOptions {
  context?: BbSdkContext;
}

export function cliFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, init);
}

export function createCliBbSdk(
  baseUrl: string,
  options: CreateCliBbSdkOptions = {},
): NodeBbSdk {
  return createNodeBbSdk({
    baseUrl,
    context: options.context,
    fetch: cliFetch,
  });
}
