const fs=require('fs');
let p='public/index.html',s=fs.readFileSync(p,'utf8');
s=s.replace('<strong>Total</strong><strong>${fmt(o.total)}</strong></div>`;', '<strong>Order total</strong><strong>${fmt(o.total)}</strong>${Number(o.amountDue??o.total)<Number(o.total)?`<strong>Amount due</strong><strong>${fmt(o.amountDue)}</strong>`:""}</div>`;');
fs.writeFileSync(p,s);
p='public/track-order.html';s=fs.readFileSync(p,'utf8');
s=s.replace('<strong>Total</strong><strong>${fmt(o.total)}</strong></div>', '<strong>Order total</strong><strong>${fmt(o.total)}</strong>${Number(o.amountDue??o.total)<Number(o.total)?`<strong>Amount due</strong><strong>${fmt(o.amountDue)}</strong>`:""}</div>');
fs.writeFileSync(p,s);
