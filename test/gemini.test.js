import test from "node:test";
import assert from "node:assert/strict";
import { toGeminiRequest, fromGeminiResponse, geminiStreamAsOpenAI } from "../src/gemini.js";

test("OpenAI tools and tool choice map to Gemini function declarations", () => {
  const request = toGeminiRequest({ messages: [{ role: "user", content: "hello" }], tools: [{ type: "function", function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }], tool_choice: "required" });
  assert.equal(request.tools[0].functionDeclarations[0].name, "get_weather");
  assert.equal(request.tools[0].functionDeclarations[0].parameters.type, "OBJECT");
  assert.equal(request.tools[0].functionDeclarations[0].parameters.properties.city.type, "STRING");
  assert.deepEqual(request.toolConfig.functionCallingConfig, { mode: "ANY" });
});

test("Gemini 4 receives the selected reasoning effort", () => {
  const request = toGeminiRequest({ model: "gemini-4-hydrogen", reasoning_effort: "medium", messages: [{ role: "user", content: "hello" }] });
  assert.deepEqual(request.generationConfig.thinkingConfig, { thinkingLevel: "MEDIUM" });
});

test("assistant tool calls and tool results map to Gemini conversation parts", () => {
  const request = toGeminiRequest({ messages: [
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Dhaka\"}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "{\"temp\":31}" }
  ] });
  assert.deepEqual(request.contents[0].parts[0].functionCall, { name: "get_weather", args: { city: "Dhaka" } });
  assert.deepEqual(request.contents[1].parts[0].functionResponse, { name: "get_weather", response: { temp: 31 } });
});

test("Gemini function calls return OpenAI tool_calls", () => {
  const response = fromGeminiResponse({ candidates: [{ content: { parts: [{ functionCall: { name: "get_weather", args: { city: "Dhaka" } } }] }, finishReason: "STOP" }] }, "gemini-4-hydrogen");
  assert.equal(response.choices[0].finish_reason, "tool_calls");
  assert.equal(response.choices[0].message.tool_calls[0].function.name, "get_weather");
  assert.deepEqual(JSON.parse(response.choices[0].message.tool_calls[0].function.arguments), { city: "Dhaka" });
});

test("Gemini streaming function calls emit OpenAI tool-call deltas", async () => {
  const payload = { candidates: [{ content: { parts: [{ functionCall: { name: "get_weather", args: { city: "Dhaka" } } }] }, finishReason: "STOP" }] };
  const upstream = new Response("data: " + JSON.stringify(payload) + "\n\n", { headers: { "content-type": "text/event-stream" } });
  const stream = await geminiStreamAsOpenAI(upstream, "gemini-4-hydrogen").text();
  assert.match(stream, /"tool_calls"/);
  assert.match(stream, /"name":"get_weather"/);
  assert.match(stream, /"finish_reason":"tool_calls"/);
  assert.ok(stream.includes("data: [DONE]"));
});

test("Gemini tool-call stream closes on finishReason even if upstream stays open", async () => {
  const payload = { candidates: [{ content: { parts: [{ functionCall: { name: "tool_describe", args: { names: ["mcp:upsy"], query: "upsy_browser_navigate" } } }] }, finishReason: "STOP" }] };
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify(payload) + "\n\n")); } });
  const upstream = new Response(body, { headers: { "content-type": "text/event-stream" } });
  const stream = await geminiStreamAsOpenAI(upstream, "gemini-4-hydrogen").text();
  assert.match(stream, /"name":"tool_describe"/);
  assert.match(stream, /"finish_reason":"tool_calls"/);
  assert.ok(stream.endsWith("data: [DONE]\n\n"));
});
