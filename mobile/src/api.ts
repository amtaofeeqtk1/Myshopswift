import * as SecureStore from 'expo-secure-store';
const base=(process.env.EXPO_PUBLIC_API_BASE_URL||'').replace(/\/$/,'');
export const imageUrl=(path?:string)=>!path?'':/^https?:\/\//i.test(path)?path:`${base}/${path.replace(/^\//,'')}`;
export async function api(path:string, options:RequestInit={}){
  if(!base)throw new Error('Set EXPO_PUBLIC_API_BASE_URL to your MyShopSwift server URL before using the app.');
  const token=await SecureStore.getItemAsync('session');
  let res:Response;
  try{res=await fetch(`${base}${path}`,{...options,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`} : {}),...options.headers}})}catch{throw new Error('You appear to be offline. Check your connection and try again.')}
  const body=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(body.error||'Something went wrong. Please try again.');
  return body;
}
export async function saveSession(token:string){await SecureStore.setItemAsync('session',token,{keychainAccessible:SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY});}
export async function clearSession(){await SecureStore.deleteItemAsync('session');}
