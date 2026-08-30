/**
 * COMPLETE WORKING EXAMPLE
 * 
 * Shows how to properly implement:
 * 1. Live activity status updates (no spam)
 * 2. API key management (externalized, rotatable)
 * 3. File search with progress
 * 4. PDF generation with live feedback
 * 5. Sub-agent communication visibility
 * 
 * Extract the patterns that match your code and apply them.
 */

const TelegramBot = require('node-telegram-bot-api');
const liveActivity = require('./live_activity.js');
const { createClient } = require('@supabase/supabase-js');

// ============================================================
// 1. API KEY MANAGEMENT (Externalized)
// ============================================================

let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // Try env first
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function loadSecretsFromDb() {
  if (ANTHROPIC_API_KEY) return; // Already have it from env
  
  try {
    const { data, error } = await supabase
      .from('agent_secrets')
      .select('value')
      .eq('key_name', 'ANTHROPIC_API_KEY')
      .single();
    
    if (error) {
      console.warn('⚠️  Could not load API key from DB:', error.message);
      return;
    }
    
    if (data?.value) {
      ANTHROPIC_API_KEY = data.value;
      console.log('✅ Loaded ANTHROPIC_API_KEY from Supabase');
    }
  } catch (e) {
    console.warn('⚠️  DB secrets load failed:', e.message);
  }
}

// Call early in your startup:
// await loadSecretsFromDb();

// ============================================================
// 2. FILE SEARCH WITH LIVE ACTIVITY
// ============================================================

async function performFileSearch(query, chatId) {
  const live = liveActivity;
  
  try {
    // Start with meaningful title
    await live.start('ගොනු සොයා ගන්නවා', {
      chatId,
      presentation: {
        title: `🔍 "${query}" සඳහා සොයනවා`,
        showTimer: true,
        showSpinner: true,
        compact: false
      }
    });

    // Step 1: Initialize
    await live.step('සෙවුම් උපකරණ ශුරු කරනවා', 'running', { chatId });
    const allFiles = await getAllFilesFromDisk(); // Your function
    const totalCount = allFiles.length;
    await live.step(`${totalCount} ගොනු පිපිරුවා`, 'done', { chatId });

    // Step 2: Search
    await live.step(`"${query}" සඳහා පරීක්ෂා කරනවා`, 'running', { chatId });
    
    const results = [];
    for (let i = 0; i < allFiles.length; i++) {
      const file = allFiles[i];
      
      // Update every 20 files to show progress
      if (i % 20 === 0 && i > 0) {
        const progress = Math.round((i / totalCount) * 100);
        await live.step(
          `${results.length} ගොනු හමුවිය (${progress}% සම්පූර්ණ)`,
          'running',
          { chatId }
        );
      }

      if (fileMatches(file, query)) {
        results.push(file);
      }
    }
    
    await live.step(
      `සෙවුම සම්පූර්ණ - ${results.length} ගොනු හමුවිය`,
      'done',
      { chatId }
    );

    // Step 3: Analysis (if results exist)
    if (results.length > 0) {
      await live.step('ප්‍රතිඵල විශ්ලේෂණ කරනවා', 'running', { chatId });
      
      // Simulate sub-agent analysis
      const summary = await analyzeResults(results);
      
      await live.step(
        `විශ්ලේෂණ සම්පූර්ණ (${summary.insights} බුද්ධිමත්තා)`,
        'done',
        { chatId }
      );
    }

    // Finish
    await live.finish(`✅ සෙවුම සම්පූර්ණ - ${results.length} ගොනු`, { chatId });
    
    return results;

  } catch (error) {
    console.error('Search error:', error);
    await live.fail(`❌ ගෝෂ: ${error.message}`, { chatId });
    throw error;
  }
}

// ============================================================
// 3. PDF GENERATION WITH LIVE FEEDBACK
// ============================================================

async function generateAndSendPDF(examName, chatId) {
  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
  const live = liveActivity;
  
  try {
    await live.start('PDF ගිණුම්කරණය', {
      chatId,
      presentation: {
        title: `📄 ${examName} PDF',
        showTimer: true
      }
    });

    // Step 1: Prepare content
    await live.step('පරීක්ෂණ ප්‍රශ්න සෙවුම කරනවා', 'running', { chatId });
    const questions = await fetchExamQuestions(examName);
    await live.step(`${questions.length} ප්‍රශ්න ලබා ගත්ත`, 'done', { chatId });

    // Step 2: Generate PDF
    await live.step('PDF උත්පාදනය කරනවා', 'running', { chatId });
    
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({
      apiKey: ANTHROPIC_API_KEY // Use loaded key, not env
    });
    
    // Get Claude to format the PDF content
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-1',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `Format these exam questions as HTML for PDF:\n${JSON.stringify(questions)}`
        }
      ]
    });

    const htmlContent = response.content[0].text;
    await live.step('PDF අන්තර්ගතය සිදු කරන ලදි', 'done', { chatId });

    // Step 3: Render HTML to PDF
    await live.step('HTML PDF බවට පරිවර්තනය කරනවා', 'running', { chatId });
    
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    
    await page.setContent(htmlContent);
    const pdfBuffer = await page.pdf({ format: 'A4' });
    await browser.close();
    
    await live.step('PDF rendered සফලයි', 'done', { chatId });

    // Step 4: Send to Telegram
    await live.step('Telegram වෙත යැවීමේ සිදුවෙමින් ඇත', 'running', { chatId });
    
    const fs = require('fs');
    const path = require('path');
    const filename = path.join('/tmp', `exam_${Date.now()}.pdf`);
    
    fs.writeFileSync(filename, pdfBuffer);
    
    const fileStream = fs.createReadStream(filename);
    await bot.sendDocument(chatId, fileStream, {
      caption: `📄 ${examName} - Complete PDF`
    });
    
    fs.unlinkSync(filename); // Clean up
    
    await live.finish(`✅ PDF යැවිලා එංගුවිය`, { chatId });

  } catch (error) {
    console.error('PDF generation error:', error);
    await live.fail(`❌ PDF නිර්මාණය අසාර්ථක: ${error.message}`, { chatId });
    throw error;
  }
}

// ============================================================
// 4. SUB-AGENT COMMUNICATION WITH VISIBILITY
// ============================================================

async function callSubAgent(agentName, task, data, chatId) {
  const live = liveActivity;
  
  await live.step(`${agentName} ඉල්ලා එංගුවිය`, 'running', { chatId });
  
  try {
    // Actually call your sub-agent
    const result = await invokeSubAgent(agentName, task, data);
    
    // Show what it returned
    await live.step(
      `${agentName} ප්‍රතිසාදය: ${result.status || 'Done'}`,
      'done',
      { chatId }
    );
    
    return result;
    
  } catch (error) {
    await live.step(
      `${agentName} අසාර්ථක: ${error.message}`,
      'error',
      { chatId }
    );
    throw error;
  }
}

// ============================================================
// 5. TELEGRAM HANDLERS (Wired properly with live activity)
// ============================================================

async function setupBotHandlers(bot) {
  
  // Search files
  bot.onText(/\/search (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const query = match[1].trim();
    
    try {
      const results = await performFileSearch(query, chatId);
      
      if (results.length === 0) {
        return bot.sendMessage(chatId, `❌ "${query}" සඳහා ගොනු හමුවුණේ නැත`);
      }
      
      // Send results summary
      const summary = results
        .slice(0, 5)
        .map(f => `📄 ${f.name}`)
        .join('\n');
      
      bot.sendMessage(chatId, `✅ හමුවුණු ගොනු:\n${summary}`);
      
    } catch (error) {
      bot.sendMessage(chatId, `❌ ගෝෂ: ${error.message}`);
    }
  });

  // Generate PDF
  bot.onText(/\/exam_pdf (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const examName = match[1].trim();
    
    try {
      await generateAndSendPDF(examName, chatId);
    } catch (error) {
      bot.sendMessage(chatId, `❌ PDF නිර්මාණය අසාර්ථක: ${error.message}`);
    }
  });

  // Rotate API key
  bot.onText(/\/rotate_key (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const newKey = match[1].trim();
    
    if (!newKey.startsWith('sk-ant-')) {
      return bot.sendMessage(chatId, '❌ Invalid key format');
    }
    
    try {
      const { error } = await supabase
        .from('agent_secrets')
        .upsert({
          key_name: 'ANTHROPIC_API_KEY',
          value: newKey,
          note: `Updated at ${new Date().toISOString()}`
        });
      
      if (error) throw error;
      
      ANTHROPIC_API_KEY = newKey;
      bot.sendMessage(chatId, '✅ API key updated. Changes take effect immediately.');
      
    } catch (error) {
      bot.sendMessage(chatId, `❌ Update failed: ${error.message}`);
    }
  });
}

// ============================================================
// HELPER FUNCTIONS (Implement your own logic here)
// ============================================================

async function getAllFilesFromDisk() {
  // Your implementation
  return [];
}

function fileMatches(file, query) {
  // Your implementation
  return file.name.includes(query);
}

async function analyzeResults(results) {
  // Your sub-agent call
  return { insights: results.length };
}

async function fetchExamQuestions(examName) {
  // Your implementation
  return [];
}

async function invokeSubAgent(name, task, data) {
  // Your implementation
  return { status: 'OK' };
}

// ============================================================
// STARTUP
// ============================================================

async function start() {
  await loadSecretsFromDb();
  
  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
  
  setupBotHandlers(bot);
  
  console.log('🤖 Bot started with proper live activity + API key management');
}

if (require.main === module) {
  start().catch(console.error);
}

module.exports = {
  performFileSearch,
  generateAndSendPDF,
  callSubAgent,
  setupBotHandlers,
  loadSecretsFromDb
};
