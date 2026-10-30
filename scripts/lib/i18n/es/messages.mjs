/**
 * Spanish: every sentence the server writes itself. The same keys as fr/messages.mjs, which documents
 * each one. The formal « usted », as the French « vous » (the owner may prefer « tú »). Written
 * 2026-10-30; the owner reviews the Spanish (VALIDATION_LOG).
 */
export default {
  code: 'es',

  languageName: 'Spanish',
  formalAddress: 'usted',
  lowercaseInSentence: true,

  flow: {
    offer: '¿Desea que le prepare una rutina personalizada?',
    yes: 'Sí, con mucho gusto',
    no: 'No, gracias',
    purchase: (name) => `Veo que ya ha comprado ${name}. ¿Desea construir su rutina en torno a este producto, le queda poco, o prefiere centrarse en su preocupación?`,
    runningLow: (name) => `Puede encontrar ${name} aquí, o añadirlo directamente a su carrito.`,
    // Their concern without an article (« en caso de arrugas »): right whatever its gender.
    treatAfterRoutine: (concern) => concern ? `Y para un momento de mimo, ideal en caso de ${concern}, este pequeño capricho podría gustarle:` : 'Y para un momento de mimo, este pequeño capricho podría gustarle:',
    treatAfterNo: 'Muy bien. Si le apetece darse un pequeño capricho, este podría gustarle:',
    cartOne: (name) => `¿Desea que añada ${name} a su carrito?`,
    cartRoutine: '¿Desea que añada esta rutina a su carrito?',
    cartRoutineDiscount: '¿Desea que añada esta rutina a su carrito? Su descuento de rutina se aplicará automáticamente.',
    cartYes: 'Sí, añadir',
    cartYesDiscount: 'Sí, añadir con el descuento',
    cartDiscount: 'Su descuento de rutina está aplicado en su carrito.',
    cartNo: 'Sigo mirando',
    cartDone: (names) => `Perfecto, añado a su carrito: ${names}.`,
    cartSize: (names) => `Para ${names}, elija el tamaño en la página del producto.`,
    cartRoutineDone: 'Perfecto, añado a su carrito los productos incluidos en su rutina.',
    cartNoDone: 'Muy bien, tómese su tiempo.',
    routineReady: 'Aquí tiene su rutina personalizada, de mañana y de noche.',
  },

  purchase: { around: 'Construir mi rutina en torno a él', running_low: 'Me queda poco', focus: 'Centrarme en mi preocupación' },

  repurchase: (name, days, promo) => `Hemos visto que ya disfrutó de «${name}». Han pasado **${days} días** desde su último pedido. ¿Desea volver a pedirlo?${promo ? ` Además, ahora mismo tenemos un ${promo} de descuento en este producto.` : ''}`,
  percent: (n) => `${n} %`,

  orderReminder: 'No olvide indicar su número de pedido en el formulario.',

  thatCode: 'ese código',

  mock: {
    default: 'Gracias por su mensaje. Esta es una respuesta de demostración: el asesor aún no está conectado.',
    find_product: 'Con mucho gusto. Para orientarle, cuénteme un poco sobre su piel: ¿seca, mixta, grasa o sensible? (Respuesta de demostración.)',
    build_routine: 'Construyamos juntos su rutina. ¿Desea una rutina de mañana, de noche o ambas? (Respuesta de demostración.)',
    compare: 'Indíqueme entre qué productos duda y le ayudaré a compararlos. (Respuesta de demostración.)',
    delivery_returns: 'La información sobre envíos y devoluciones estará disponible aquí muy pronto. (Respuesta de demostración.)',
    offers: 'Las ofertas del momento estarán disponibles aquí muy pronto. (Respuesta de demostración.)',
    product_title: 'Producto de ejemplo',
    product_rationale: 'Tarjeta de demostración: las sugerencias reales llegarán con el catálogo.',
  },
};
