import { Router } from 'express'
import { requireAuth } from '../src/middleware/requireAuth.js'
import { withClientScope } from '../src/middleware/withClientScope.js'

const router = Router()

router.get('/ping', requireAuth, withClientScope, (req, res) => {
  res.json({ ok: true, userId: req.user.id, clientIds: req.clientIds })
})

export default router
