const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', dateStyle: 'short' });
export function dailyReceipts(rows: Array<{
  status: string; orderType: string; paymentMethod: string; paymentStatus: string;
  total: number; subtotal: number; commissionAmount: number; payload: unknown;
  statusHistory: Array<{ toStatus: string; createdAt: Date }>;
}>, now = new Date()) {
  const day = calendar.format(now);
  let count = 0, cash = 0, transfers = 0, supplier = 0, commissions = 0, tipsCash = 0, tipsBank = 0, fees = 0;
  let debt = 0, cashCount = 0, bankCount = 0;
  const cents = (value: number) => Math.round(value * 100);
  for (const row of rows) {
    const data = row.payload as { bankVerification?: { verifiedAt?: string; verifiedAmount?: number }; tipAmount?: number };
    const finalEvent = row.statusHistory.find(event => event.toStatus === row.status);
    if (row.status === 'cancelado_con_deuda' && finalEvent && calendar.format(finalEvent.createdAt) === day) debt += cents(row.total);
    if (['pendiente_cotizacion','cancelado','cancelado_con_deuda'].includes(row.status)) continue;
    const transfer = row.paymentMethod === 'transferencia';
    const date = transfer && row.paymentStatus === 'verificado' && data.bankVerification?.verifiedAt
      ? new Date(data.bankVerification.verifiedAt)
      : !transfer && row.status === 'entregado' ? finalEvent?.createdAt : undefined;
    if (!date || !Number.isFinite(date.getTime()) || calendar.format(date) !== day) continue;
    const received = cents(transfer ? data.bankVerification?.verifiedAmount ?? row.total : row.total);
    const tip = cents(data.tipAmount || 0);
    const deliveryOnly = ['envio','solicitud_local'].includes(row.orderType);
    const commission = deliveryOnly ? 0 : cents(row.commissionAmount);
    const payable = deliveryOnly ? 0 : cents(row.subtotal) - commission;
    count++;
    if (transfer) { transfers += received; tipsBank += tip; bankCount++; }
    else { cash += received; tipsCash += tip; cashCount++; }
    supplier += payable;
    commissions += commission;
    fees += received - payable - commission - tip;
  }
  return { count, cashCount, bankCount, totalVolume: (cash + transfers) / 100, totalCashRodoNet: (cash - tipsCash) / 100,
    totalTransfer: transfers / 100, totalCommissions: commissions / 100, totalDeliveryFees: fees / 100,
    totalRodoIncome: (fees + commissions) / 100, cashTipsTotal: tipsCash / 100, transferTipsTotal: tipsBank / 100,
    supplierTotal: supplier / 100, debtTotal: debt / 100 };
}
