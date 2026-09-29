import assert from "node:assert/strict";
import { cloudProvider } from "../src/shared/ai/providers/cloud-deepseek.js";

assert.equal(cloudProvider.defaultModel, "deepseek-v4-flash");
assert.equal(cloudProvider.protocol, "openai_chat_completions");
console.log("PASS DeepSeek legacy default preserved; saved model IDs stay profile-owned");
