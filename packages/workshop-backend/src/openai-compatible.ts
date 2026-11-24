import type { FetchFunction } from "@earendil-works/pi-ai";
import { normalizeModelApiRoot } from "@gadgets/workshop-shared/model-api-root";

/** Resolve the Chat Completions destination at save time and again when using a stored model. */
export function compatibleModelEndpoint(env: Cloudflare.Env, apiUrl?: string) {
  const baseUrl = normalizeModelApiRoot(apiUrl);
  const roots: unknown = JSON.parse(env.SELF_HOSTED_MODEL_BASE_URLS ?? "[]");
  if (!Array.isArray(roots)) throw new Error("SELF_HOSTED_MODEL_BASE_URLS must be a JSON array.");
  const privateRoot = roots.includes(baseUrl);
  const binding = privateRoot ? env.SELF_HOSTED_MODEL : undefined;
  if (privateRoot && !binding) throw new Error("The self-hosted model transport is unavailable.");
  if (!binding && !baseUrl.startsWith("https://")) {
    throw new Error("Use HTTPS or ask the operator to allow this exact HTTP model API root.");
  }

  const fetch: FetchFunction = async (input, init) => {
    const request = new Request(input, { ...init, redirect: "manual" });
    if (request.method !== "POST" || request.url !== `${baseUrl}/chat/completions`) {
      throw new Error("Unexpected Chat Completions request destination.");
    }
    // Global fetch has workerd's public-address restriction. Only the private binding can
    // reach an operator-approved internal server, and it checks the destination independently.
    const response = binding ? await binding.fetch(request) : await globalThis.fetch(request);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return Response.json({
        error: { message: "The model server redirected the request. Enter its final API root." },
      }, { status: 400 });
    }
    return response;
  };
  return { baseUrl, fetch };
}
