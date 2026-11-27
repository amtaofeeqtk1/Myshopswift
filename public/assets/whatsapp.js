// MyShopSwift — WhatsApp order enquiry link.
//
// This is a customer-support shortcut, NOT automatic live tracking: it opens
// a WhatsApp chat with the official MyShopSwift number with the order
// reference already typed in. The only thing put in the link is the same
// short order reference customers already see in their emails and on the
// Track Order page — never a name, address, phone number, email or total.
//
// wa.me is WhatsApp's official universal link: it opens the app on Android
// and iOS, and WhatsApp Web / Desktop on a computer.
(function () {
  var NUMBER = "447739320205"; // official number 07739 320205, in international format (no + or spaces)

  function ref(orderId) {
    return String(orderId).slice(0, 8);
  }

  function link(orderId) {
    var text = "Hello MyShopSwift, I would like to check the status of my order. My order reference is " + ref(orderId) + ".";
    // encodeURIComponent also encodes "#" (as %23) — left raw it would cut the message off.
    return "https://wa.me/" + NUMBER + "?text=" + encodeURIComponent(text);
  }

  window.MSSWhatsApp = { number: NUMBER, ref: ref, link: link };
})();
