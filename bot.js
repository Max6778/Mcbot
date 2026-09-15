const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')

// ==== CONFIG (fill these in or use env vars) ====
const HOST = process.env.MC_HOST || 'veryevilserver.aternos.me'
const PORT = parseInt(process.env.MC_PORT || '25565')
const USERNAME = process.env.MC_USERNAME || 'theguyaj'
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
    startRandomMovement(bot)
    startBreakPlaceLoop(bot)
  })

  let banned = false

  bot.on('kicked', (reason) => {
    console.log('Kicked:', reason)
    if (String(reason).toLowerCase().includes('banned')) {
      banned = true
      console.log('Account/server banned — stopping reconnect attempts.')
    }
  })
  bot.on('error', (err) => console.log('Error:', err))

  bot.on('end', () => {
    if (banned) return
    console.log('Disconnected, reconnecting in 30s...')
    setTimeout(createBot, 30000)
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

function startRandomMovement(bot) {
  const directions = ['forward', 'back', 'left', 'right']
  let current = null

  setInterval(() => {
    try {
      // release whatever we were doing
      if (current) bot.setControlState(current, false)

      // randomly stand still sometimes, otherwise pick a direction
      if (Math.random() < 0.3) {
        current = null
        return
      }

      current = directions[Math.floor(Math.random() * directions.length)]
      bot.setControlState(current, true)

      // occasional jump so it can hop over 1-block edges
      if (Math.random() < 0.2) {
        bot.setControlState('jump', true)
        setTimeout(() => bot.setControlState('jump', false), 250)
      }
    } catch (e) {
      console.log('Movement tick error:', e.message)
    }
  }, 3000) // change direction every 3s
}

function startBreakPlaceLoop(bot) {
  setInterval(async () => {
    try {
      const belowPos = bot.entity.position.offset(0, -1, 0).floored()
      const block = bot.blockAt(belowPos)

      if (!block || block.name === 'air' || block.name === 'bedrock') return
      if (!bot.canDigBlock(block)) return

      const blockName = block.name
      await bot.dig(block)
      await new Promise((res) => setTimeout(res, 500))

      // find the item that matches what we just dug (it should be in inventory now)
      const item = bot.inventory.items().find((i) => i.name === blockName)
      if (!item) return // nothing to place back with, leave the hole

      await bot.equip(item, 'hand')

      // place it back using the block one further below as the reference face
      const referenceBlock = bot.blockAt(belowPos.offset(0, -1, 0))
      if (!referenceBlock || referenceBlock.name === 'air') return

      await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0))
    } catch (e) {
      console.log('Break/place tick error:', e.message)
    }
  }, 15000) // every 15s
}

createBot()
