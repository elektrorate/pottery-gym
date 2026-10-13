import React, { createContext, useContext } from 'react';

export const initialAuth = { session: { user: { id: 'owner-a' }, access_token: 'token-a' }, sedeId: 'sede-a', isSuperAdmin: false };
export const TestAuthContext = createContext(initialAuth);
let currentAuth = initialAuth;
export const useAuth = () => { currentAuth = useContext(TestAuthContext); return currentAuth; };

export const clientCalls: any[] = [];
export const clientResponses: any[] = [];
class Query {
  private request: any;
  private signal?: AbortSignal;
  constructor(table?: string, name?: string, args?: any) {
    this.request = table ? { table, filters: [], orders: [], scope: { sedeId: currentAuth.sedeId, isSuperAdmin: currentAuth.isSuperAdmin } } : { name, args };
  }
  select(columns = '*', options?: any) { this.request.columns = columns; this.request.count = options?.count; return this; }
  eq(key: string, value: any) { this.request.filters.push(['eq', key, value]); return this; }
  gte(key: string, value: any) { this.request.filters.push(['gte', key, value]); return this; }
  lte(key: string, value: any) { this.request.filters.push(['lte', key, value]); return this; }
  order(key: string, options?: any) { this.request.orders.push([key, options?.ascending]); return this; }
  range(start: number, end: number) { this.request.start = start; this.request.end = end; return this; }
  limit(limit: number) { this.request.limit = limit; return this; }
  abortSignal(signal: AbortSignal) { this.signal = signal; return this; }
  then(resolve?: (response: any) => any, reject?: (error: any) => any) {
    clientCalls.push(structuredClone(this.request));
    return fetch('/__data-provider-integrity', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.request), signal: this.signal }).then(response => response.json()).then(response => {
        clientResponses.push(structuredClone(this.request)); return response;
      }).then(resolve, reject);
  }
}
export const supabase = {
  from: (table: string) => new Query(table),
  rpc: (name: string, args: any) => new Query(undefined, name, args)
};
