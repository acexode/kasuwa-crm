export type TaxOwnerKind = 'quote' | 'invoice';

export interface TaxLine {
  id: string;
  programmeId: string;
  ownerKind: TaxOwnerKind;
  ownerId: string;
  code: string;
  rateBps: number;
  amountMinor: string;
}
