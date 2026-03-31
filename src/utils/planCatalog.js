const PLAN_CATALOG = {
  starter: {
    name: 'Starter',
    name_ar: 'الخطة المبدئية',
    price_monthly: 499,
    price_label: '$499 / month',
    price_label_ar: '499$ / شهر',
    user_limit: 5,
    query_limit: 500,
    popular: false,
    feature_list: [
      'Up to 5 users',
      '500 queries per month',
      'Role-based access control',
      'Downloadable reports',
      'Cloud deployment',
      'No support included'
    ],
    feature_list_ar: [
      'حتى 5 مستخدمين',
      '500 استعلام شهريا',
      'التحكم في الوصول حسب الدور',
      'تقارير قابلة للتنزيل',
      'نشر سحابي',
      'لا يشمل الدعم'
    ]
  },
  growth: {
    name: 'Growth',
    name_ar: 'خطة النمو',
    price_monthly: 1499,
    price_label: '$1,499 / month',
    price_label_ar: '1,499$ / شهر',
    user_limit: 20,
    query_limit: 2000,
    popular: true,
    feature_list: [
      'Up to 20 users',
      '2,000 queries per month',
      'Role-based access control',
      'Downloadable reports',
      'Email support',
      'Enhanced performance & scalability'
    ],
    feature_list_ar: [
      'حتى 20 مستخدما',
      '2,000 استعلام شهريا',
      'التحكم في الوصول حسب الدور',
      'تقارير قابلة للتنزيل',
      'دعم عبر البريد الإلكتروني',
      'أداء وقابلية توسع محسنان'
    ]
  },
  enterprise: {
    name: 'Enterprise',
    name_ar: 'خطة المؤسسات',
    price_monthly: 0,
    price_label: 'Custom Pricing',
    price_label_ar: 'تسعير مخصص',
    user_limit: null,
    query_limit: null,
    popular: false,
    feature_list: [
      'Unlimited users',
      'Unlimited queries',
      'On-premise deployment',
      'Role-based access control',
      'Downloadable reports',
      'Email + chat support',
      'Dedicated meeting support',
      'Complete data privacy'
    ],
    feature_list_ar: [
      'مستخدمون غير محدودين',
      'استعلامات غير محدودة',
      'نشر داخل البنية المحلية',
      'التحكم في الوصول حسب الدور',
      'تقارير قابلة للتنزيل',
      'دعم عبر البريد والدردشة',
      'دعم اجتماعات مخصص',
      'خصوصية بيانات كاملة'
    ]
  }
};

function getPlanCatalogEntry(planName) {
  const key = String(planName || '').trim().toLowerCase();
  return PLAN_CATALOG[key] || null;
}

function enrichPlanRecord(plan = {}) {
  const catalogEntry = getPlanCatalogEntry(plan.name);
  if (!catalogEntry) {
    return {
      ...plan,
      price_label: plan.price_monthly ? `$${plan.price_monthly} / month` : null,
      price_label_ar: null,
      feature_list: Array.isArray(plan.feature_list) ? plan.feature_list : [],
      feature_list_ar: Array.isArray(plan.feature_list_ar) ? plan.feature_list_ar : [],
      popular: Boolean(plan.popular)
    };
  }

  return {
    ...plan,
    name: catalogEntry.name,
    name_ar: catalogEntry.name_ar,
    price_monthly: catalogEntry.price_monthly,
    price_label: catalogEntry.price_label,
    price_label_ar: catalogEntry.price_label_ar,
    user_limit: catalogEntry.user_limit,
    query_limit: catalogEntry.query_limit,
    feature_list: catalogEntry.feature_list,
    feature_list_ar: catalogEntry.feature_list_ar,
    popular: catalogEntry.popular
  };
}

function resolvePlanPrice(plan = {}) {
  const enriched = enrichPlanRecord(plan);
  return Number(enriched.price_monthly || 0);
}

module.exports = {
  PLAN_CATALOG,
  getPlanCatalogEntry,
  enrichPlanRecord,
  resolvePlanPrice
};
