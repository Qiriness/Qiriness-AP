/** English: every sentence the server writes itself. The same keys as fr/messages.mjs, which documents each one. */
export default {
  code: 'en',

  languageName: 'English',
  formalAddress: '',
  lowercaseInSentence: true,

  flow: {
    offer: 'Would you like me to build you a personalised routine?',
    yes: 'Yes please',
    no: 'No thanks',
    purchase: (name) => `I can see you've bought ${name} before. Would you like to build your routine around it, are you running low on it, or would you rather focus on your concern?`,
    runningLow: (name) => `You'll find ${name} here, or you can add it straight to your cart.`,
    treatAfterRoutine: (concern) => concern ? `And for a little moment of pampering, perfect for easing your ${concern}, you might like this treat:` : 'And for a little moment of pampering, you might like this treat:',
    treatAfterNo: 'Of course. If you fancy a little treat, you might like this one:',
    cartOne: (name) => `Would you like me to add ${name} to your cart?`,
    cartRoutine: 'Would you like me to add this routine to your cart?',
    cartRoutineDiscount: 'Would you like me to add this routine to your cart? Your routine discount will be applied automatically.',
    cartYes: 'Yes, add it',
    cartYesDiscount: 'Yes, add it with the discount',
    cartDiscount: 'Your routine discount is applied to your cart.',
    cartNo: "I'm still looking",
    cartDone: (names) => `Done, adding to your cart: ${names}.`,
    cartSize: (names) => `For ${names}, please choose the size on its page.`,
    cartRoutineDone: 'Done, adding the products included in your routine to your cart.',
    cartNoDone: 'Of course, take your time.',
    routineReady: 'Here is your personalised routine, morning and evening.',
  },

  purchase: { around: 'Build my routine around it', running_low: "I'm running low", focus: 'Focus on my concern' },

  repurchase: (name, days, promo) => `We noticed you have enjoyed ${name} before. It has now been **${days} days** since you last ordered it. Would you like to get it again?${promo ? ` We even have ${promo} off this product right now.` : ''}`,
  percent: (n) => `${n}%`,

  orderReminder: "Don't forget to include your order number in the form.",

  thatCode: 'that code',

  mock: {
    default: 'Thank you for your message. This is a demo reply: the advisor is not connected yet.',
    find_product: 'With pleasure. To guide you, tell me a little about your skin: dry, combination, oily or sensitive? (Demo reply.)',
    build_routine: 'Let\'s build your routine together. Would you like a morning routine, an evening routine, or both? (Demo reply.)',
    compare: 'Tell me which products you are hesitating between and I will help you compare them. (Demo reply.)',
    delivery_returns: 'Delivery and returns information will be available here soon. (Demo reply.)',
    offers: 'Current offers will be available here soon. (Demo reply.)',
    product_title: 'Sample product',
    product_rationale: 'Demo card: real suggestions will come with the catalogue.',
  },
};
