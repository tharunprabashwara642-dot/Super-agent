// ============================================================
// ADD THIS TO YOUR index.js (around line 6585, BEFORE the /voice endpoint)
// ============================================================

/**
 * POST /api/agent
 * Web UI endpoint for the agent — accepts a message and returns:
 *   { content, steps, toolCalls }
 * 
 * This reuses the same Claude model + tools as the Telegram bot,
 * but returns structured output instead of Telegram updates.
 */
app.post('/api/agent', async (req, res) => {
  try {
    const { message, userId } = req.body;

    // Validate input
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Empty or invalid message' });
    }

    // Optional: verify userId is valid format (not required for MVP)
    const cleanUserId = (userId || 'web-user').replace(/[^a-z0-9-]/gi, '');

    console.log(`📡 Web API request from ${cleanUserId}: "${message.slice(0, 50)}..."`);

    // 1. Fetch user profile & recent memories (same as Telegram)
    const profile = await getUserProfile();
    const memories = await fetchRecentMemories();

    // 2. Build system prompt (same context as Telegram)
    const now = nowInTimezone();
    let systemInstruction = SYSTEM_INSTRUCTION_BASE;
    systemInstruction += `\n\nCurrent date/time: ${now.readable} (ISO: ${now.iso}, timezone ${TIMEZONE})`;
    if (profile) systemInstruction += `\n\nUser profile:\n${profile}`;
    if (memories.length > 0) systemInstruction += `\n\nSaved facts:\n- ${memories.join('\n- ')}`;

    // 3. Call Claude with the message
    // (This is the same callClaude flow as the Telegram request handler)
    const toolDecls = [
      ...CHAT_TOOLS[0].functionDeclarations,
      ...mcpToolDeclarations,
      ...customToolDeclarations,
    ];

    const messages = [
      { role: 'user', parts: [{ text: message }] }
    ];

    const response = await callClaude({
      messages,
      systemInstruction,
      toolDecls,
      model: ANTHROPIC_TEXT_MODEL,
      maxTokens: parseInt(process.env.ANTHROPIC_MAX_TOKENS || 16000),
    });

    // 4. Process tool calls (execute them, not just log)
    const steps = [];
    const toolCalls = [];
    let finalText = '';

    for (const block of response.content) {
      if (block.type === 'text') {
        finalText = block.text;
      } else if (block.type === 'tool_use') {
        steps.push(`Calling ${block.name}…`);
        
        const toolCall = {
          id: block.id,
          name: block.name,
          args: block.input || {},
          result: null,
        };

        try {
          // Run the tool (same logic as Telegram)
          const toolResult = await runToolDirectly(block.name, block.input || {});
          toolCall.result = toolResult;
          
          if (toolResult.error) {
            steps.push(`${block.name} failed: ${toolResult.error}`);
          } else {
            steps.push(`${block.name} completed`);
          }
        } catch (e) {
          toolCall.result = { error: e.message };
          steps.push(`${block.name} error: ${e.message}`);
        }

        toolCalls.push(toolCall);
      }
    }

    steps.push('Composing reply…');

    // 5. Return structured response
    const apiResponse = {
      success: true,
      content: finalText,
      steps,
      toolCalls,
      usage: response.usage || {},
    };

    // 6. Log API usage (if tracking)
    if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
      try {
        const today = new Date().toISOString().split('T')[0];
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
        await supabase
          .from('api_usage')
          .update({ anthropic_calls: 1 })
          .eq('date', today)
          .then((r) => {
            if (r.error?.code === 'PGRST116') {
              // No row for today, insert
              return supabase.from('api_usage').insert({ date: today, anthropic_calls: 1 });
            }
          });
      } catch (e) {
        console.warn('Could not log API usage:', e.message);
      }
    }

    console.log(`✅ Web API response (${toolCalls.length} tool calls)`);
    res.json(apiResponse);

  } catch (error) {
    console.error('❌ Web API error:', error.message);
    res.status(500).json({ 
      error: error.message || 'Internal server error',
      success: false 
    });
  }
});

// ============================================================
// HELPER: callClaude (if you don't have it already)
// ============================================================
// This is a wrapper around the Anthropic SDK that the endpoint uses.
// If you already have a similar function, use that instead.

async function callClaude({ messages, systemInstruction, toolDecls, model, maxTokens }) {
  // Make sure you have Anthropic SDK imported:
  // const Anthropic = require('@anthropic-ai/sdk');
  // And ANTHROPIC_API_KEY is set in your env vars.

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const response = await client.messages.create({
    model: model || 'claude-opus-5',
    max_tokens: maxTokens || 16000,
    system: systemInstruction,
    tools: toolDecls.map(fn => ({
      name: fn.name,
      description: fn.description,
      input_schema: {
        type: 'object',
        properties: fn.parameters?.properties || {},
        required: fn.parameters?.required || [],
      },
    })),
    messages: messages.map(msg => ({
      role: msg.role,
      content: msg.parts
        ? msg.parts.map(p => ({
            type: p.inlineData ? 'image' : 'text',
            ...(p.text && { text: p.text }),
            ...(p.inlineData && {
              source: {
                type: 'base64',
                media_type: p.inlineData.mimeType,
                data: p.inlineData.data,
              },
            }),
          }))
        : [{ type: 'text', text: msg.content }],
    })),
  });

  return response;
}

// ============================================================
// If you're using this endpoint, make sure your app.post('/api/agent', ...)
// is BEFORE the /voice WebSocket handler, and BEFORE the final
// httpServer.listen() call.
// ============================================================
