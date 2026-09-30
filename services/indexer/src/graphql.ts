import {
  createSchema,
  createYoga,
  type YogaInitialContext,
} from "graphql-yoga";
import type { Db } from "./db-types";
import { toClaimRow } from "./db-types";

interface GraphQLContext extends YogaInitialContext {
  db: Db;
}

const typeDefs = /* GraphQL */ `
  type Claim {
    id: Int!
    wallet: String!
    credentialType: String!
    issuer: String!
    verifiedAt: Int!
    expiry: Int!
    ledgerSequence: Int!
    threshold: Int
    revoked: Boolean!
    reasonCode: String!
  }

  input ClaimFilter {
    wallet: String
    credentialType: String
    issuer: String
    active: Boolean
    revoked: Boolean
    verifiedAfter: Int
    verifiedBefore: Int
  }

  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  type ClaimConnection {
    edges: [Claim!]!
    pageInfo: PageInfo!
  }

  type Query {
    claims(
      filter: ClaimFilter
      first: Int = 20
      after: String
    ): ClaimConnection!
  }
`;

function encodeCursor(ledgerSequence: number, id: number): string {
  return Buffer.from(`${ledgerSequence}:${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { ledgerSequence: number; id: number } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const [ledgerSequence, id] = decoded.split(":").map(Number);
    if (Number.isNaN(ledgerSequence) || Number.isNaN(id)) return null;
    return { ledgerSequence, id };
  } catch {
    return null;
  }
}

function buildWhereClause(filter: any, params: (string | number)[]): string {
  const conditions: string[] = [];

  if (filter?.wallet) {
    conditions.push("wallet = ?");
    params.push(filter.wallet);
  }
  if (filter?.credentialType) {
    conditions.push("credential_type = ?");
    params.push(filter.credentialType);
  }
  if (filter?.issuer) {
    conditions.push("issuer = ?");
    params.push(filter.issuer);
  }
  if (filter?.active === true) {
    conditions.push("revoked = 0");
  }
  if (filter?.revoked === true) {
    conditions.push("revoked = 1");
  }
  if (filter?.verifiedAfter !== undefined) {
    conditions.push("verified_at >= ?");
    params.push(filter.verifiedAfter);
  }
  if (filter?.verifiedBefore !== undefined) {
    conditions.push("verified_at <= ?");
    params.push(filter.verifiedBefore);
  }

  return conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
}

export function createGraphQLSchema(db: Db) {
  return createSchema<GraphQLContext>({
    typeDefs,
    resolvers: {
      Query: {
        claims: async (_parent: any, args: any, _context: any) => {
          const { filter, first = 20, after } = args;
          const limit = Math.min(Math.max(1, first), 100);
          const params: (string | number)[] = [];
          const whereClause = buildWhereClause(filter, params);

          let cursorCondition = "";
          if (after) {
            const cursor = decodeCursor(after);
            if (cursor) {
              cursorCondition = whereClause
                ? ` AND (ledger_sequence < ? OR (ledger_sequence = ? AND id < ?))`
                : `WHERE (ledger_sequence < ? OR (ledger_sequence = ? AND id < ?))`;
              params.push(cursor.ledgerSequence, cursor.ledgerSequence, cursor.id);
            }
          }

          const sql = `SELECT * FROM claims ${whereClause}${cursorCondition} ORDER BY ledger_sequence DESC, id DESC LIMIT ?`;
          params.push(limit + 1);

          const rows = await (db as any).dialect.all(sql, params);
          const hasNextPage = rows.length > limit;
          const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

          const edges = pageRows.map((row: any) => {
            const claim = toClaimRow(row);
            return {
              ...claim,
              credentialType: claim.credential_type,
              verifiedAt: claim.verified_at,
              ledgerSequence: claim.ledger_sequence,
              revoked: claim.revoked !== 0,
              reasonCode: claim.reason_code,
            };
          });

          const lastRow = pageRows[pageRows.length - 1];
          const endCursor = lastRow
            ? encodeCursor(Number(lastRow.ledger_sequence), Number(lastRow.id))
            : "";

          return {
            edges,
            pageInfo: {
              hasNextPage,
              endCursor,
            },
          };
        },
      },
    },
  });
}

export function createGraphQLHandler(db: Db) {
  const schema = createGraphQLSchema(db);
  return createYoga<GraphQLContext>({
    schema,
    context: async () => ({ db }),
  });
}
