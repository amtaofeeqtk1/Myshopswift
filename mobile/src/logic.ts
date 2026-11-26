export type CartLine={productId:number;qty:number;brand?:string;replacement?:string;note?:string};
export const basketSubtotal=(items:CartLine[], products:any[])=>items.reduce((sum,line)=>sum+(Number(products.find(p=>String(p.id)===String(line.productId))?.price)||0)*line.qty,0);
export const amountAfterPoints=(total:number,points:number,pointsPerPound:number)=>Math.max(0,Math.round((total-Math.min(total,points/Math.max(1,pointsPerPound)))*100)/100);
export const orderStatusLabel=(status:string)=>({awaiting_payment:'Awaiting payment',pending:'Order received',processing:'Being prepared',shipped:'On the way to you',delivered:'Delivered',cancelled:'Cancelled'}[status]||status);
export const checkoutMethods=['card','points'] as const;
export const isAllowedMobilePayment=(method:string)=>checkoutMethods.includes(method as any);
export function paymentReturn(url:string){const parsed=new URL(url);return {orderId:parsed.searchParams.get('order'),sessionId:parsed.searchParams.get('session_id'),cancelled:parsed.searchParams.get('paid')==='0'};}
