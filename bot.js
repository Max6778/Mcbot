const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')

// ==== CONFIG (env vars override these) ====
const HOST = process.env.MC_HOST || 'veryevilserver.aternos.me'
const PORT = parseInt(process.env.MC_PORT || '25565')
const USERNAME = process.env.MC_USERNAME || 'therealaj'
const VERSION = process.env.MC_VERSION || '1.21.11'

const ENABLE_MOVEMENT = process.env.ENABLE_MOVEMENT !== 'false'
const ENABLE_BREAK_PLACE = process.env.ENABLE_BREAK_PLACE !== 'false'
const ENABLE_MOB_AVOIDANCE = process.env.ENABLE_MOB_AVOIDANCE !== 'false'
// ============================================

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args)
}

let reconnectDelay = 5000 // starts at 5s, backs off up to MAX_DELAY on repeated failures
const MAX_DELAY = 5 * 60 * 1000 // 5 min cap

function createBot() {
  const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    version: VERSION,
    auth: 'offline'
  })

  let banned = false

  bot.on('spawn', () => {
    log('Bot spawned')
    reconnectDelay = 5000 // reset backoff after a successful connection
    const state = { fleeing: false, hurt: false }

    startAntiAfk(bot, state)
    if (ENABLE_MOVEMENT) startRandomMovement(bot, state)
    if (ENABLE_BREAK_PLACE) startBreakPlaceLoop(bot, state)
    if (ENABLE_MOB_AVOIDANCE) startMobAvoidance(bot, state)
    startHealthMonitor(bot, state)
  })

  bot.on('kicked', (reason) => {
    log('Kicked:', JSON.stringify(reason, null, 2))
    if (JSON.stringify(reason).toLowerCase().includes('banned')) {
      banned = true
      log('Account/server banned — stopping reconnect attempts.')
    }
  })

  bot.on('death', () => {
    log('Bot died, respawning...')
    bot.respawn()
  })

  bot.on('error', (err) => log('Error:', err.message || err))

  bot.on('end', () => {
    if (banned) return
    log(`Disconnected, reconnecting in ${reconnectDelay / 1000}s...`)
    setTimeout(createBot, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY)
  })

  return bot
}

function startAntiAfk(bot, state) {
  setInterval(() => {
    try {
      if (state.hurt) return
      bot.setControlState('jump', true)
      setTimeout(() => bot.setControlState('jump', false), 300)
      bot.look(Math.random() * Math.PI * 2, 0, true)
    } catch (e) {
      log('Anti-AFK tick error:', e.message)
    }
  }, 20000)
}

function startHealthMonitor(bot, state) {
  bot.on('health', () => {
    if (bot.health <= 10) {
      if (!state.hurt) log(`Health low (${bot.health}/20) — pausing movement to recover`)
      state.hurt = true
    } else if (bot.health >= 18) {
      state.hurt = false
    }
  })
}

const HAZARD_BLOCKS = ['lava', 'fire', 'cactus', 'magma_block', 'campfire', 'soul_campfire']

// Solid collision check
function isBlocked(bot, yaw) {
  const dx = -Math.sin(yaw)
  const dz = -Math.cos(yaw)
  const pos = bot.entity.position.offset(dx, 0, dz).floored()
  const feetBlock = bot.blockAt(pos)
  const headBlock = bot.blockAt(pos.offset(0, 1, 0))
  const isSolid = (b) => b && b.boundingBox === 'block'
  return isSolid(feetBlock) || isSolid(headBlock)
}

// Hazard/void check: is stepping this way a bad idea (lava, fire, or a long fall)?
function isDangerous(bot, yaw) {
  const dx = -Math.sin(yaw)
  const dz = -Math.cos(yaw)
  const pos = bot.entity.position.offset(dx, 0, dz).floored()
  const standingBlock = bot.blockAt(pos)
  if (standingBlock && HAZARD_BLOCKS.includes(standingBlock.name)) return true

  // check for a drop of more than 2 blocks (fall damage territory)
  for (let depth = 1; depth <= 3; depth++) {
    const below = bot.blockAt(pos.offset(0, -depth, 0))
    if (below && below.boundingBox === 'block') {
      return depth > 2 // safe if solid ground is within 2 blocks, otherwise treat as a ledge
    }
  }
  return true // nothing solid found in range below -> void/long drop
}

function steerAroundWalls(bot, yaw) {
  const blockedOrUnsafe = (y) => isBlocked(bot, y) || isDangerous(bot, y)
  if (!blockedOrUnsafe(yaw)) return yaw

  const rightYaw = yaw - Math.PI / 2
  const leftYaw = yaw + Math.PI / 2
  if (!blockedOrUnsafe(rightYaw)) return rightYaw
  if (!blockedOrUnsafe(leftYaw)) return leftYaw
  return yaw + Math.PI // boxed in or surrounded by hazards, turn around
}

function startRandomMovement(bot, state) {
  const directions = ['forward', 'back', 'left', 'right']
  let current = null

  setInterval(() => {
    try {
      if (state.fleeing || state.hurt) return

      if (current) bot.setControlState(current, false)

      if (Math.random() < 0.3) {
        current = null
        return
      }

      current = directions[Math.floor(Math.random() * directions.length)]

      if (current === 'forward') {
        const desiredYaw = steerAroundWalls(bot, bot.entity.yaw)
        bot.look(desiredYaw, 0, true)
      }

      bot.setControlState(current, true)

      if (Math.random() < 0.2) {
        bot.setControlState('jump', true)
        setTimeout(() => bot.setControlState('jump', false), 250)
      }
    } catch (e) {
      log('Movement tick error:', e.message)
    }
  }, 3000)
}

function startBreakPlaceLoop(bot, state) {
  setInterval(async () => {
    try {
      if (state.fleeing || state.hurt) return

      const belowPos = bot.entity.position.offset(0, -1, 0).floored()
      const block = bot.blockAt(belowPos)

      if (!block || block.name === 'air' || block.name === 'bedrock') return
      if (!bot.canDigBlock(block)) return

      const blockName = block.name
      await bot.dig(block)
      await new Promise((res) => setTimeout(res, 500))

      const item = bot.inventory.items().find((i) => i.name === blockName)
      if (!item) return

      await bot.equip(item, 'hand')

      const referenceBlock = bot.blockAt(belowPos.offset(0, -1, 0))
      if (!referenceBlock || referenceBlock.name === 'air') return

      await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0))
    } catch (e) {
      log('Break/place tick error:', e.message)
    }
  }, 15000)
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
        if (!state.fleeing) log('Hostile mob nearby, fleeing:', threat.name || threat.mobType)
        state.fleeing = true
        const away = bot.entity.position.minus(threat.position)
        let yaw = Math.atan2(-away.x, -away.z) + Math.PI
        yaw = steerAroundWalls(bot, yaw)
        bot.look(yaw, 0, true)

        bot.setControlState('forward', true)
        bot.setControlState('sprint', true)

        if (Math.random() < 0.3) {
          bot.setControlState('jump', true)
          setTimeout(() => bot.setControlState('jump', false), 250)
        }
      } else if (state.fleeing) {
        state.fleeing = false
        bot.setControlState('forward', false)
        bot.setControlState('sprint', false)
      }
    } catch (e) {
      log('Mob avoidance tick error:', e.message)
    }
  }, 1000)
}

createBot()
