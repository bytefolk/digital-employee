import assert from "node:assert/strict";
import test from "node:test";
import { ExtractiveModel } from "../../connectors/models/extractive/index.js";
import { OpenAICompatibleModel } from "../../connectors/models/openai-compatible/index.js";

test("extractive model returns the best approved context with its citation", async () => {
  const model = new ExtractiveModel();
  const result = await model.generate({
    question: "Which permission should I use?",
    contexts: [
      {
        score: 0.7,
        document: { id: "doc-1", title: "Handbook", text: "Use a one-time permission." }
      }
    ]
  });

  assert.match(result.answer, /one-time permission/);
  assert.deepEqual(result.citationIds, ["doc-1"]);
  assert.equal(result.needsHuman, false);
});

test("extractive model requests human review without evidence", async () => {
  const model = new ExtractiveModel();
  const result = await model.generate({ contexts: [] });
  assert.equal(result.needsHuman, true);
  assert.equal(result.confidence, 0);
});

test("OpenAI-compatible model rejects private endpoints by default", () => {
  assert.throws(
    () =>
      new OpenAICompatibleModel({
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "test",
        model: "local"
      }),
    /allow_private_network/
  );
  assert.throws(
    () =>
      new OpenAICompatibleModel({
        baseUrl: "https://[::ffff:127.0.0.1]/v1",
        apiKey: "test",
        model: "local"
      }),
    /allow_private_network/
  );
  assert.throws(
    () =>
      new OpenAICompatibleModel({
        baseUrl: "https://[fec0::1]/v1",
        apiKey: "test",
        model: "local"
      }),
    /allow_private_network/
  );
  assert.throws(
    () =>
      new OpenAICompatibleModel({
        baseUrl: "https://[64:ff9b::a00:1]/v1",
        apiKey: "test",
        model: "local"
      }),
    /allow_private_network/
  );
  assert.doesNotThrow(
    () =>
      new OpenAICompatibleModel({
        baseUrl: "https://[64:ff9b::808:808]/v1",
        apiKey: "test",
        model: "public"
      })
  );
});

test("OpenAI-compatible model rejects hostnames that resolve to private addresses", async () => {
  let requested = false;
  const model = new OpenAICompatibleModel({
    baseUrl: "https://models.example.test/v1",
    apiKey: "test-key",
    model: "example",
    lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
    requestImpl: async () => {
      requested = true;
      return { status: 200, body: "{}" };
    }
  });

  await assert.rejects(
    () => model.generate({ question: "test", contexts: [] }),
    /allow_private_network/
  );
  assert.equal(requested, false);
});

test("OpenAI-compatible model pins the validated IP and parses output", async () => {
  let request;
  const model = new OpenAICompatibleModel({
    baseUrl: "https://models.example.test/v1",
    apiKey: "test-key",
    model: "example",
    lookupImpl: async () => [{ address: "1.1.1.1", family: 4 }],
    requestImpl: async (options) => {
      request = options;
      return {
        status: 200,
        body: JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  answer: "Use the documented flow.",
                  confidence: 0.82,
                  citationIds: ["doc-1"],
                  needsHuman: false
                })
              }
            }
          ]
        })
      };
    }
  });

  const result = await model.generate({
    question: "What should I do?",
    contexts: [{ id: "doc-1", title: "Guide", text: "Use the documented flow." }],
    profile: { instructions: "Answer from evidence." }
  });

  assert.equal(
    String(request.endpoint),
    "https://models.example.test/v1/chat/completions"
  );
  assert.deepEqual(request.pinnedAddress, {
    address: "1.1.1.1",
    family: 4
  });
  assert.equal(request.headers.authorization, "Bearer test-key");
  assert.equal(result.answer, "Use the documented flow.");
  assert.deepEqual(result.citationIds, ["doc-1"]);
});

test("OpenAI-compatible model does not surface provider error bodies", async () => {
  const model = new OpenAICompatibleModel({
    baseUrl: "https://models.example.test/v1",
    apiKey: "test-key",
    model: "example",
    lookupImpl: async () => [{ address: "1.1.1.1", family: 4 }],
    requestImpl: async () => ({
      status: 401,
      body: "provider-secret-detail"
    })
  });

  await assert.rejects(
    () => model.generate({ question: "test", contexts: [] }),
    (error) => error.message === "model_request_failed:401"
  );
});
