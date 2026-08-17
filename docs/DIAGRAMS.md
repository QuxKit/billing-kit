# billing-kit — diagrams

The mermaid sources for this repo. They live here rather than in the
README because npm renders no mermaid: on the package page a fence
like this one ships as raw DSL. GitHub and the QuxKit docs site both
draw them. The README carries an ASCII equivalent of each.

## The settle line — what billing-kit owns, and what the provider owns

```mermaid
flowchart LR
    app(["your app"])

    subgraph BK["billing-kit — Apache-2.0"]
        direction LR
        ev[("usage_events")]
        agg[("aggregates")]
        chg["charges"]
        led[("ledger<br/>append-only, double-entry")]
        ev -->|aggregate| agg
        agg -->|price| chg
        chg -->|post| led
    end

    subgraph PV["provider — Stripe / Paddle / Lago"]
        inv["invoice + capture"]
        hook[["webhook"]]
    end

    app -->|record usage| ev
    led -->|settle period| inv
    hook -->|payment or refund| led

    classDef own fill:#0d9488,stroke:#0f766e,color:#ffffff;
    classDef prov fill:#d97706,stroke:#b45309,color:#ffffff;
    classDef edge fill:#1e293b,stroke:#0f172a,color:#e2e8f0;
    class ev,agg,chg,led own;
    class inv,hook prov;
    class app edge;
```

## One charge and its payment: two transactions, each summing to zero

```mermaid
flowchart TB
    subgraph T1["charge chg_1 — two legs, sum to zero"]
        direction LR
        a1["customer_balance<br/>+19.99 debit"]:::debit
        b1["revenue_accrued<br/>−19.99 credit"]:::credit
    end
    subgraph T2["payment webhook pay_9 — two legs, sum to zero"]
        direction LR
        a2["cash<br/>+19.99 debit"]:::debit
        b2["customer_balance<br/>−19.99 credit"]:::credit
    end
    T1 --> T2 --> note
    note["customer_balance = +19.99 − 19.99 = 0<br/>the charge is settled, and every row is still there"]:::note

    classDef debit fill:#0d9488,stroke:#0f766e,color:#ffffff;
    classDef credit fill:#7c3aed,stroke:#6d28d9,color:#ffffff;
    classDef note fill:#1e293b,stroke:#334155,color:#e2e8f0;
```
