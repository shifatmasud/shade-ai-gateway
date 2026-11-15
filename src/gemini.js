function toGeminiRequest(body) {
 const contents=[]; let systemText="";
 for(const m of body.messages){const role=m.role==="assistant"?"model":"user";const items=Array.isArray(m.content)?m.content:[{type:"text",text:String(m.content??"")}];const parts=[];
 for(const item of items){if(typeof item==="string")parts.push({text:item});else if(item?.type==="text"&&typeof item.text==="string")parts.push({text:item.text});else if(item?.type==="image_url"&&item.image_url?.url?.startsWith("data:")){const match=item.image_url.url.match(/^data:([^;,]+);base64,(.+)$/);if(match)parts.push({inline_data:{mime_type:match[1],data:match[2]}});}}
 if(m.role==="system"||m.role==="developer")systemText+=(systemText?"\n\n":"")+parts.map(p=>p.text||"").join("");else if(parts.length){const prev=contents[contents.length-1];if(prev?.role===role)prev.parts.push(...parts);else contents.push({role,parts});}}
 const generationConfig={};if(Number.isFinite(body.temperature))generationConfig.temperature=body.temperature;if(Number.isFinite(body.top_p))generationConfig.topP=body.top_p;if(Number.isInteger(body.max_tokens))generationConfig.maxOutputTokens=body.max_tokens;if(Number.isInteger(body.max_completion_tokens))generationConfig.maxOutputTokens=body.max_completion_tokens;if(Array.isArray(body.stop))generationConfig.stopSequences=body.stop;
 const out={contents};if(systemText)out.systemInstruction={parts:[{text:systemText}]};if(Object.keys(generationConfig).length)out.generationConfig=generationConfig;return out;
}
function fromGeminiResponse(payload,model){const c=payload?.candidates?.[0];const text=(c?.content?.parts||[]).map(p=>p.text||"").join("");const prompt=payload?.usageMetadata?.promptTokenCount||0;const completion=payload?.usageMetadata?.candidatesTokenCount||0;return{id:"chatcmpl-"+(payload?.responseId||crypto.randomUUID().replace(/-/g,"")),object:"chat.completion",created:Math.floor(Date.now()/1000),model,choices:[{index:0,message:{role:"assistant",content:text},finish_reason:c?.finishReason==="MAX_TOKENS"?"length":"stop"}],usage:{prompt_tokens:prompt,completion_tokens:completion,total_tokens:prompt+completion}};}
function geminiStreamAsOpenAI(response, model, onDone) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const id = "chatcmpl-" + crypto.randomUUID().replace(/-/g, "");
    const created = Math.floor(Date.now() / 1000);
    let buffer = "";
    let closed = false;
    function translateLine(line, controller) {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        let payload;
        try { payload = JSON.parse(data); } catch { return; }
        const candidate = payload?.candidates?.[0];
        const text = (candidate?.content?.parts || []).map(part => part.text || "").join("");
        if (text) {
            const chunk = { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
            controller.enqueue(encoder.encode("data: " + JSON.stringify(chunk) + "\n\n"));
        }
        if (candidate?.finishReason) {
            const chunk = { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: candidate.finishReason === "MAX_TOKENS" ? "length" : "stop" }] };
            controller.enqueue(encoder.encode("data: " + JSON.stringify(chunk) + "\n\n"));
        }
    }
    return new Response(new ReadableStream({
        async pull(controller) {
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) {
                        buffer += decoder.decode();
                        if (buffer.trim()) translateLine(buffer.trim(), controller);
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                        controller.close();
                        if (!closed) { closed = true; onDone?.(); }
                        return;
                    }
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split(/\r?\n/);
                    buffer = lines.pop() || "";
                    for (const line of lines) translateLine(line, controller);
                    if (lines.length) return;
                }
            } catch (cause) {
                controller.error(cause);
                if (!closed) { closed = true; onDone?.(); }
            }
        },
        async cancel() {
            try { await reader.cancel(); } finally {
                if (!closed) { closed = true; onDone?.(); }
            }
        }
    }), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}

export { toGeminiRequest, fromGeminiResponse, geminiStreamAsOpenAI };
