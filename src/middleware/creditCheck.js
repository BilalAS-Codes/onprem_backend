const creditService = require('../services/creditService');
const checkCredits = async (req, res, next) => {
  try {
    const organizationId = req.user.organization_id;

    if (!organizationId) {
      return res.status(401).json({ error: 'Organization not identified' });
    }

    const creditCheck = await creditService.hasCredits(organizationId, 1);

    if (!creditCheck.allowed) {
      return res.status(403).json({ 
        error: 'Insufficient credits',
        message: creditCheck.reason,
        action: 'upgrade_plan'
      });
    }

    // Attach quota to request for later use
    req.quota = creditCheck.quota;
    next();

  } catch (error) {
    console.error('Credit check error:', error);
    return res.status(500).json({ error: 'Failed to verify credits' });
  }
};

module.exports = { checkCredits };