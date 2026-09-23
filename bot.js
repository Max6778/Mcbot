const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')

// ==== CONFIG (env vars override these) ====
const HOST = process.env.MC_HOST || 'example.aternos.me'
const PORT = parseInt(process.env.MC_PORT || '25565')
const USERNAME = process.env.MC_USERNAME || 'therealaj'
const VERSION = process.env.MC_VERSION || '1.21.11'

const ENABLE_MOVEMENT = process.env.ENABLE_MOVEMENT !== 'false'
const ENABLE_BREAK_PLACE = process.env.ENABLE_BREAK_PLACE !== 'true'
const ENABLE_MOB_AVOIDANCE = process.env.ENABLE_MOB_AVOIDANCE !== 'false'
// ============================================

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args)
}

let reconnectDelay = 5000
const MAX_DELAY = 5 * 60 * 1000
let consecutiveFailures = 0
const MAX_CONSECUTIVE_FAILURES = 8 // give up after this many failed attempts in a row

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
    reconnectDelay = 5000
    consecutiveFailures = 0
    // fleeing: currently running from a mob. busy: mid dig/place, don't let movement interrupt it.
    const state = { fleeing: false, busy: false }

    startAntiAfk(bot, state)
    if (ENABLE_MOVEMENT) startRandomMovement(bot, state)
    if (ENABLE_BREAK_PLACE) startBreakPlaceLoop(bot, state)
    if (ENABLE_MOB_AVOIDANCE) startMobAvoidance(bot, state)
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
    consecutiveFailures++
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      log(`Gave up after ${consecutiveFailures} failed attempts in a row — server likely offline. Exiting.`)
      process.exit(1)
    }
    log(`Disconnected, reconnecting in ${reconnectDelay / 1000}s... (attempt ${consecutiveFailures})`)
    setTimeout(createBot, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY)
  })

  return bot
}

function startAntiAfk(bot, state) {
  setInterval(() => {
    try {
      bot.setControlState('jump', true)
      setTimeout(() => bot.setControlState('jump', false), 300)
      bot.look(Math.random() * Math.PI * 2, 0, true)
    } catch (e) {
      log('Anti-AFK tick error:', e.message)
    }
  }, 20000)
}

const HAZARD_BLOCKS = ['lava', 'fire', 'cactus', 'magma_block', 'campfire', 'soul_campfire']

function isBlocked(bot, yaw) {
  const dx = -Math.sin(yaw)
  const dz = -Math.cos(yaw)
  const pos = bot.entity.position.offset(dx, 0, dz).floored()
  const feetBlock = bot.blockAt(pos)
  const headBlock = bot.blockAt(pos.offset(0, 1, 0))
  const isSolid = (b) => b && b.boundingBox === 'block'
  return isSolid(feetBlock) || isSolid(headBlock)
}

function isDangerous(bot, yaw) {
  const dx = -Math.sin(yaw)
  const dz = -Math.cos(yaw)
  const pos = bot.entity.position.offset(dx, 0, dz).floored()
  const standingBlock = bot.blockAt(pos)
  if (standingBlock && HAZARD_BLOCKS.includes(standingBlock.name)) return true

  for (let depth = 1; depth <= 3; depth++) {
    const below = bot.blockAt(pos.offset(0, -depth, 0))
    if (below && below.boundingBox === 'block') {
      return depth > 2
    }
  }
  return true
}

function steerAroundWalls(bot, yaw) {
  const blockedOrUnsafe = (y) => isBlocked(bot, y) || isDangerous(bot, y)
  if (!blockedOrUnsafe(yaw)) return yaw

  const rightYaw = yaw - Math.PI / 2
  const leftYaw = yaw + Math.PI / 2
  if (!blockedOrUnsafe(rightYaw)) return rightYaw
  if (!blockedOrUnsafe(leftYaw)) return leftYaw
  return yaw + Math.PI
}

function startRandomMovement(bot, state) {
  const directions = ['forward', 'back', 'left', 'right']
  let current = null

  setInterval(() => {
    try {
      if (state.fleeing || state.busy) return

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
    if (state.fleeing || state.busy) return
    state.busy = true

    ;['forward', 'back', 'left', 'right'].forEach((d) => bot.setControlState(d, false))

    // if a mob shows up mid-dig, cancel immediately instead of letting it error out on its own
    const fleeWatcher = setInterval(() => {
      if (state.fleeing) bot.stopDigging()
    }, 200)

    try {
      const belowPos = bot.entity.position.offset(0, -1, 0).floored()
      const block = bot.blockAt(belowPos)

      if (!block || block.name === 'air' || block.name === 'bedrock') return
      if (!bot.canDigBlock(block)) return

      const blockName = block.name
      await bot.dig(block)
      await new Promise((res) => setTimeout(res, 500))

      if (state.fleeing) return // don't bother placing back if we're now running from a mob

      const item = bot.inventory.items().find((i) => i.name === blockName)
      if (!item) return

      await bot.equip(item, 'hand')

      const referenceBlock = bot.blockAt(belowPos.offset(0, -1, 0))
      if (!referenceBlock || referenceBlock.name === 'air') return

      await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0))
    } catch (e) {
      const msg = e.message || String(e)
      if (!msg.toLowerCase().includes('abort')) {
        log('Break/place tick error:', msg) // "aborted" is expected when fleeing interrupts a dig, so skip logging that case
      }
    } finally {
      clearInterval(fleeWatcher)
      state.busy = false
    }
  }, 20000)
}

const HOSTILE_MOBS = [
  'zombie', 'skeleton', 'spider', 'cave_spider', 'creeper', 'enderman',
  'witch', 'zombie_villager', 'husk', 'stray', 'drowned', 'phantom',
  'pillager', 'vindicator', 'evoker', 'slime', 'magma_cube', 'blaze',
  'ghast', 'silverfish', 'guardian', 'elder_guardian', 'shulker', 'piglin_brute'
]

function startMobAvoidance(bot, state) {
  const FLEE_RADIUS = 10
  const MIN_FLEE_MS = 6000 // keep sprinting at least this long after last seeing a threat, to put real distance
  let fleeUntil = 0

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
        fleeUntil = Date.now() + MIN_FLEE_MS

        // vector from threat to bot = direction pointing AWAY from the threat
        const away = bot.entity.position.minus(threat.position)
        let yaw = Math.atan2(-away.x, -away.z) // NOTE: no +Math.PI here — that was the bug that sent it charging the mob
        yaw = steerAroundWalls(bot, yaw)
        bot.look(yaw, 0, true)

        bot.setControlState('forward', true)
        bot.setControlState('sprint', true)

        if (Math.random() < 0.3) {
          bot.setControlState('jump', true)
          setTimeout(() => bot.setControlState('jump', false), 250)
        }
      } else if (state.fleeing) {
        if (Date.now() < fleeUntil) {
          // no threat in range right now, but keep running the last direction to put real distance down
          const yaw = steerAroundWalls(bot, bot.entity.yaw)
          bot.look(yaw, 0, true)
          bot.setControlState('forward', true)
          bot.setControlState('sprint', true)
        } else {
          state.fleeing = false
          bot.setControlState('forward', false)
          bot.setControlState('sprint', false)
        }
      }
    } catch (e) {
      log('Mob avoidance tick error:', e.message)
    }
  }, 1000)
}

createBot()

