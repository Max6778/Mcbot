const mineflayer = require('mineflayer')

// ==== CONFIG (fill these in or use env vars) ====
const HOST = process.env.MC_HOST || 'yourserver.aternos.me'
const PORT = parseInt(process.env.MC_PORT || '25565')
const USERNAME = process.env.MC_USERNAME || '24/7bot'
const VERSION = process.env.MC_VERSION || '1.21.11'
// =================================================

function createBot() {
  const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    version: VERSION,
    auth: 'offline' // change to 'microsoft' if the server requires premium/online-mode accounts
  })

  bot.on('spawn', () => {
    console.log(`[${new Date().toISOString()}] Bot spawned, starting anti-AFK loop`)
    startAntiAfk(bot)
  })

  bot.on('kicked', (reason) => console.log('Kicked:', reason))
  bot.on('error', (err) => console.log('Error:', err))

  bot.on('end', () => {
    console.log('Disconnected, reconnecting in 5s...')
    setTimeout(createBot, 5000)
  })

  return bot
}

function startAntiAfk(bot) {
  // Small periodic actions so the server doesn't consider the bot idle
  setInterval(() => {
    try {
      bot.setControlState('jump', true)
      setTimeout(() => bot.setControlState('jump', false), 300)

      // Slight look/turn so it isn't perfectly static
      const yaw = Math.random() * Math.PI * 2
      bot.look(yaw, 0, true)
    } catch (e) {
      console.log('Anti-AFK tick error:', e.message)
    }
  }, 20000) // every 20s
}

createBot()
