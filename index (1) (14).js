import 'dotenv/config'

import { Buffer } from 'node:buffer'

import {

  Client,

  GatewayIntentBits,

  EmbedBuilder,

  Partials,

  AttachmentBuilder,

  ActionRowBuilder,

  ButtonBuilder,

  ButtonStyle,

  ModalBuilder,

  TextInputBuilder,

  TextInputStyle

} from 'discord.js'

import path from 'node:path'

import fs from 'node:fs'

import os from 'node:os'

import { GoogleGenerativeAI } from '@google/generative-ai'

import Tesseract from 'tesseract.js'

import archiver from 'archiver'

const DISCORD_TOKEN = " token "

const GEMINI_KEY = " api "

const GEMINI_MODEL  = process.env.GEMINI_MODEL || 'gemini-2.5-flash'

const genAI = new GoogleGenerativeAI(GEMINI_KEY)

const geminiModel = genAI.getGenerativeModel({ model: GEMINI_MODEL })

const client = new Client({

  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],

  partials: [Partials.Channel]

})

const EXT_MAP = {

  js: 'js', javascript: 'js', node: 'js',

  ts: 'ts', typescript: 'ts',

  py: 'py', python: 'py',

  html: 'html', htm: 'html',

  css: 'css',

  json: 'json',

  sql: 'sql',

  sh: 'sh', bash: 'sh',

  yml: 'yml', yaml: 'yml',

  java: 'java',

  c: 'c',

  cpp: 'cpp',

  cs: 'cs',

  php: 'php',

  xml: 'xml',

  txt: 'txt'

}

function nowStamp() {

  const d = new Date()

  const pad = (n)=>String(n).padStart(2,'0')

  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

}

function limit1024(text, fallback='—') {

  if (!text) return fallback

  return text.length > 1024 ? text.slice(0, 1021)+'...' : text

}

function isCodeRequest(q) {

  const s = (q||'').toLowerCase()

  return /(^|\s)(كود|code|script|ا اصنع كود|أرسل كود|اكتب كود|سو كود|سكريبت)(\s|$)/.test(s)

      || /\b(js|javascript|ts|typescript|py|python|html|css|json|sql|bash|sh|regex|express|discord\.js)\b/.test(s)

      || /```/.test(s)

}

function isProjectRequest(q) {

  return /^اصنع مشروع/i.test(q) || /^أصنع مشروع/i.test(q)

}

function guessLangFromText(q) {

  const s = (q||'').toLowerCase()

  if (/typescript|\bts\b/.test(s)) return 'ts'

  if (/javascript|\bjs\b|node|discord\.js/.test(s)) return 'js'

  if (/python|\bpy\b/.test(s)) return 'py'

  if (/\bhtml\b/.test(s)) return 'html'

  if (/\bcss\b/.test(s)) return 'css'

  if (/\bsql\b/.test(s)) return 'sql'

  if (/\bjson\b/.test(s)) return 'json'

  if (/\bbash\b|\bsh\b/.test(s)) return 'sh'

  if (/\bjava\b/.test(s)) return 'java'

  if (/\bcpp\b|\bc\+\+\b/.test(s)) return 'cpp'

  if (/\bcsharp\b|\bcs\b/.test(s)) return 'cs'

  if (/\bphp\b/.test(s)) return 'php'

  if (/\bxml\b/.test(s)) return 'xml'

  return 'txt'

}

function extractBestCodeBlocks(text, preferredLang='txt') {

  const re = /```([\w.+-]*)\n([\s\S]*?)```/g

  const blocks = []

  let m

  while ((m = re.exec(text)) !== null) {

    const lang = (m[1] || 'txt').toLowerCase()

    const code = (m[2] || '').trim()

    if (!code) continue

    blocks.push({ lang, code, length: code.length })

  }

  if (!blocks.length) return null

  const same = blocks.filter(b => (b.lang === preferredLang) || (EXT_MAP[b.lang] === EXT_MAP[preferredLang]))

  const pick = (same.length ? same : blocks).sort((a,b)=>b.length - a.length)[0]

  const lang = EXT_MAP[pick.lang] ? pick.lang : 'txt'

  return { language: lang, code: pick.code }

}

function buildEmbed({ question, statusOnline=true, note='' }) {

  return new EmbedBuilder()

    .setTitle('| ShareBot Status')

    .setDescription('📢 حالة البوت والرد على سؤالك')

    .setColor(statusOnline ? 0x00ff88 : 0xff0000)

    .addFields(

      { name: '🔹 ShareBot', value: statusOnline ? 'Online 🟢' : 'Offline 🔴', inline: true },

      { name: '💬 سؤالك', value: limit1024(question || '—') },

      { name: '📦 المخرجات', value: limit1024(note || '—') }

    )

    .setTimestamp()

}

async function askGeminiRaw(prompt) {

  try {

    const result = await geminiModel.generateContent(prompt)

    const resp = result?.response

    const text = typeof resp?.text === 'function' ? await resp.text() : (resp?.text || '')

    return text || ''

  } catch (err) {

    return `❌ خطأ من Gemini: ${err?.message || String(err)}`

  }

}

async function askForCodeOnly(question, langHint) {

  const lang = langHint || guessLangFromText(question)

  const firstPrompt = `

المهمة: أعد كود ${lang} فقط استجابةً للطلب التالي.

- كتلة كود واحدة فقط.

- ابدأ بـ \`\`\`${lang}\n وانتهِ بـ \n\`\`\`.

${question}`.trim()

  let text = await askGeminiRaw(firstPrompt)

  let best = extractBestCodeBlocks(text, lang)

  if (!best) {

    const retryPrompt = `

STRICT OUTPUT:

\`\`\`${lang}

<code>

\`\`\`

${question}`.trim()

    text = await askGeminiRaw(retryPrompt)

    best = extractBestCodeBlocks(text, lang)

  }

  return best || null

}

const lastCodeByUser = new Map()

const WZ = {

  START_BTN: 'improve_code:start',

  MODAL_ID:  'improve_code:modal',

  F_DESC:    'improve_field:desc',

  F_CHANGES: 'improve_field:changes',

  F_CODE:    'improve_field:code'

}

function buildImproveRow() {

  return new ActionRowBuilder().addComponents(

    new ButtonBuilder().setCustomId(WZ.START_BTN).setLabel('تحسين الكود').setStyle(ButtonStyle.Primary).setEmoji('🛠️')

  )

}

function buildImproveModal() {

  const modal = new ModalBuilder().setCustomId(WZ.MODAL_ID).setTitle('🛠️ تحسين الكود')

  const desc = new TextInputBuilder().setCustomId(WZ.F_DESC).setLabel('الوصف العام').setStyle(TextInputStyle.Short).setRequired(true)

  const changes = new TextInputBuilder().setCustomId(WZ.F_CHANGES).setLabel('التعديلات المطلوبة').setStyle(TextInputStyle.Paragraph).setRequired(true)

  const code = new TextInputBuilder().setCustomId(WZ.F_CODE).setLabel('الكود (اختياري)').setStyle(TextInputStyle.Paragraph).setRequired(false)

  modal.addComponents(

    new ActionRowBuilder().addComponents(desc),

    new ActionRowBuilder().addComponents(changes),

    new ActionRowBuilder().addComponents(code)

  )

  return modal

}

function buildImprovePrompt({ language, code, desc, changes }) {

  const lang = language || 'txt'

  return `

حسّن الكود التالي:

${desc}

${changes}

\`\`\`${lang}

${code}

\`\`\``.trim()

}

async function buildProjectZip(language, mainCode) {

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj_'))

  let mainFile = 'index.' + language

  if (language === 'py') mainFile = 'main.py'

  if (language === 'html') mainFile = 'index.html'

  if (language === 'css') mainFile = 'style.css'

  if (language === 'json') mainFile = 'data.json'

  if (language === 'sql') mainFile = 'schema.sql'

  if (language === 'sh') mainFile = 'script.sh'

  if (language === 'java') mainFile = 'Main.java'

  if (language === 'c') mainFile = 'main.c'

  if (language === 'cpp') mainFile = 'main.cpp'

  if (language === 'cs') mainFile = 'Program.cs'

  if (language === 'php') mainFile = 'index.php'

  if (language === 'xml') mainFile = 'file.xml'

  if (language === 'txt') mainFile = 'readme.txt'

  const files = [

    { name: mainFile, content: mainCode },

    { name: 'README.md', content: `## مشروع ${language}\n\nالملف الرئيسي: ${mainFile}` }

  ]

  for (const f of files) fs.writeFileSync(path.join(tmpDir, f.name), f.content, 'utf8')

  const zipPath = path.join(os.tmpdir(), `project_${nowStamp()}.zip`)

  const output = fs.createWriteStream(zipPath)

  const archive = archiver('zip')

  archive.pipe(output)

  for (const f of files) archive.file(path.join(tmpDir, f.name), { name: f.name })

  await archive.finalize()

  return zipPath

}

client.once('ready', () => {

  console.log(`✅ متصل كـ ${client.user.tag}`)

})

client.on('messageCreate', async (message) => {

  try {

    if (message.author.bot) return

    if (!message.mentions.has(client.user)) return

    if (message.attachments.size > 0) {

      const img = message.attachments.first()

      if (img && img.contentType?.startsWith('image/')) {

        await message.channel.sendTyping()

        const ocrResult = await Tesseract.recognize(img.url, 'eng+ara')

        const extractedText = (ocrResult?.data?.text || '').trim()

        if (extractedText) {

          const aiResponse = await askGeminiRaw(`هذا نص من صورة:\n${extractedText}\nأجب عنه باختصار.`)

          const embed = buildEmbed({ question: '[صورة]', note: aiResponse })

          return message.reply({ embeds: [embed] })

        } else {

          return message.reply({ content: '❌ ما قدرت أقرأ النص من الصورة.' })

        }

      }

    }

    const question = message.content.replace(/<@!?(\d+)>/g, '').trim()

    if (!question) return

    await message.channel.sendTyping()

    if (isProjectRequest(question)) {

      const lang = guessLangFromText(question)

      const result = await askForCodeOnly(question, lang)

      if (!result) return message.reply("❌ ما قدرت أجهز الكود.")

      const zipPath = await buildProjectZip(result.language, result.code)

      const file = new AttachmentBuilder(zipPath)

      const embed = buildEmbed({ question, statusOnline: true, note: `📦 تم إنشاء مشروع كامل (${result.language})` })

      return message.reply({ embeds: [embed], files: [file], components: [buildImproveRow()] })

    }

    if (isCodeRequest(question)) {

      const lang = guessLangFromText(question)

      const result = await askForCodeOnly(question, lang)

      if (!result) return message.reply("❌ ما قدرت أستخرج كود.")

      const ext = EXT_MAP[result.language] || 'txt'

      const fileName = `code_${nowStamp()}.${ext}`

      const buffer = Buffer.from(result.code, 'utf8')

      const file = new AttachmentBuilder(buffer, { name: fileName })

      lastCodeByUser.set(message.author.id, { code: result.code, language: result.language, at: new Date() })

      const embed = buildEmbed({ question, statusOnline: true, note: `📄 تم إنشاء كود (${result.language})` })

      return message.reply({ embeds: [embed], files: [file], components: [buildImproveRow()] })

    }

    const text = await askGeminiRaw(question)

    const embed = buildEmbed({ question, statusOnline: true, note: text })

    return message.reply({ embeds: [embed] })

  } catch (e) {

    console.error(e)

    message.reply("❌ خطأ غير متوقع.")

  }

})

client.on('interactionCreate', async (interaction) => {

  try {

    if (interaction.isButton() && interaction.customId === WZ.START_BTN) {

      return interaction.showModal(buildImproveModal())

    }

    if (interaction.isModalSubmit() && interaction.customId === WZ.MODAL_ID) {

      await interaction.deferReply({ ephemeral: true })

      const desc    = interaction.fields.getTextInputValue(WZ.F_DESC)?.trim()

      const changes = interaction.fields.getTextInputValue(WZ.F_CHANGES)?.trim()

      const pasted  = (interaction.fields.getTextInputValue(WZ.F_CODE) || '').trim()

      let language = 'txt'

      let sourceCode = ''

      if (pasted) {

        const block = extractBestCodeBlocks(pasted) || { language: guessLangFromText(pasted), code: pasted }

        language = block.language || 'txt'

        sourceCode = block.code || pasted

      } else {

        const last = lastCodeByUser.get(interaction.user.id)

        if (last?.code) {

          language = last.language || 'txt'

          sourceCode = last.code

        }

      }

      if (!sourceCode) {

        return interaction.editReply({ content: '⚠️ ما لقيت كود للتحسين.' })

      }

      const prompt = buildImprovePrompt({ language, code: sourceCode, desc, changes })

      const aiText = await askGeminiRaw(prompt)

      const improved = extractBestCodeBlocks(aiText, language)

      if (!improved) {

        return interaction.editReply({ content: '❌ ما قدرت أطلع كود محسّن.' })

      }

      const ext = EXT_MAP[improved.language] || 'txt'

      const outName = `improved_${nowStamp()}.${ext}`

      const fileBuf = Buffer.from(improved.code, 'utf8')

      const file = new AttachmentBuilder(fileBuf, { name: outName })

      lastCodeByUser.set(interaction.user.id, { code: improved.code, language: improved.language, at: new Date() })

      const doneEmbed = new EmbedBuilder()

        .setTitle('🛠️ تم تحسين الكود')

        .setColor(0x00ff88)

        .setDescription('تم إرسال النسخة المحسّنة.')

        .addFields(

          { name: 'اللغة', value: improved.language, inline: true },

          { name: 'الملف', value: outName, inline: true }

        )

        .setTimestamp()

      return interaction.editReply({ embeds: [doneEmbed], files: [file] })

    }

  } catch (err) {

    console.error(err)

  }

})

client.login("token")

// 43 لا تنسى تحط توكن في سطر 