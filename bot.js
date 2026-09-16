const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')

// ==== CONFIG (fill these in or use env vars) ====
const HOST = process.env.MC_HOST || 'veryevilserver.aternos.me'
const PORT = parseInt(process.env.MC_PORT || '25565')
const USERNAME = process.env.MC_USERNAME || 'therealaj'
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
    const state = { fleeing: false }
    startAntiAfk(bot)
    startRandomMovement(bot, state)
    startBreakPlaceLoop(bot)
    startMobAvoidance(bot, state)
  })

  let banned = false

  bot.on('kicked', (reason) => {
    console.log('Kicked:', JSON.stringify(reason, null, 2))
    if (JSON.stringify(reason).toLowerCase().includes('banned')) {
      banned = true
      console.log('Account/server banned — stopping reconnect attempts.')
    }
  })
  bot.on('death', () => {
    console.log('Bot died, respawning...')
    bot.respawn()
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

// Returns true if there's a solid block at feet or head height one step in the given yaw direction
function isBlocked(bot, yaw) {
  const dx = -Math.sin(yaw)
  const dz = -Math.cos(yaw)
  const pos = bot.entity.position.offset(dx, 0, dz).floored()
  const feetBlock = bot.blockAt(pos)
  const headBlock = bot.blockAt(pos.offset(0, 1, 0))
  const isSolid = (b) => b && b.boundingBox === 'block'
  return isSolid(feetBlock) || isSolid(headBlock)
}

// If the given yaw is blocked, steer right if the left side is open, or vice versa.
// Returns the yaw the bot should actually face/move toward.
function steerAroundWalls(bot, yaw) {
  if (!isBlocked(bot, yaw)) return yaw

  const rightYaw = yaw - Math.PI / 2
  const leftYaw = yaw + Math.PI / 2
  const rightBlocked = isBlocked(bot, rightYaw)
  const leftBlocked = isBlocked(bot, leftYaw)

  if (!rightBlocked) return rightYaw // wall ahead/left -> go right
  if (!leftBlocked) return leftYaw   // wall ahead/right -> go left
  return yaw + Math.PI // boxed in, turn around
}

function startRandomMovement(bot, state) {
  const directions = ['forward', 'back', 'left', 'right']
  let current = null

  setInterval(() => {
    try {
      if (state.fleeing) return // mob avoidance has priority, don't fight it

      // release whatever we were doing
      if (current) bot.setControlState(current, false)

      // randomly stand still sometimes, otherwise pick a direction
      if (Math.random() < 0.3) {
        current = null
        return
      }

      current = directions[Math.floor(Math.random() * directions.length)]

      // if moving forward and a wall's in the way, steer around it instead
      if (current === 'forward') {
        const desiredYaw = steerAroundWalls(bot, bot.entity.yaw)
        bot.look(desiredYaw, 0, true)
      }

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

const HOSTILE_MOBS = [
  'zombie', 'skeleton', 'spider', 'cave_spider', 'creeper', 'enderman',
  'witch', 'zombie_villager', 'husk', 'stray', 'drowned', 'phantom',
  'pillager', 'vindicator', 'evoker', 'slime', 'magma_cube', 'blaze',
  'ghast', 'silverfish', 'guardian', 'elder_guardian', 'shulker', 'piglin_brute'
]

function startMobAvoidance(bot, state) {
  const FLEE_RADIUS = 8

  setInterval(() => {
    try {
      const threat = Object.values(bot.entities).find((e) => {
        if (!e.position || e === bot.entity) return false
        if (e.type !== 'mob' && e.type !== 'hostile') return false
        const name = (e.name || e.mobType || '').toLowerCase()
        if (!HOSTILE_MOBS.some((m) => name.includes(m))) return false
        return bot.entity.position.distanceTo(e.position) <= FLEE_RADIUS
      })

      if (threat) {
        state.fleeing = true
        // vector pointing away from the threat
        const away = bot.entity.position.minus(threat.position)
        let yaw = Math.atan2(-away.x, -away.z) + Math.PI // face away
        yaw = steerAroundWalls(bot, yaw) // don't run face-first into a wall
        bot.look(yaw, 0, true)

        bot.setControlState('forward', true)
        bot.setControlState('sprint', true)

        // jump occasionally in case of obstacles/holes while fleeing
        if (Math.random() < 0.3) {
          bot.setControlState('jump', true)
          setTimeout(() => bot.setControlState('jump', false), 250)
        }
      } else if (state.fleeing) {
        // threat gone, stop sprinting away and let normal wandering resume
        state.fleeing = false
        bot.setControlState('forward', false)
        bot.setControlState('sprint', false)
      }
    } catch (e) {
      console.log('Mob avoidance tick error:', e.message)
    }
  }, 1000) // check every second
}

createBot()
