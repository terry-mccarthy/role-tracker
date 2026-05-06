# Scoring Methodology

## How role scoring works

When you paste a job description into the scorer, Claude evaluates it against your `config/evaluation-profile.md` using the weighted dimensions defined there.

## Dimensions (from your profile)

| Dimension | Weight | What's assessed |
|---|---|---|
| Lifestyle | 25% | Hybrid policy, expected hours, commute, travel requirements |
| Compensation | 20% | Base salary range vs your floor, cash vs equity mix, benefits |
| Scope & Growth | 20% | Org size, reporting line, title, VP/CTO trajectory |
| People | 20% | Manager quality signals, peer strength, team maturity |
| Company & Mission | 15% | Stage, industry, culture signals, runway |

## Scoring scale

Each dimension is scored 1–10:

- **9–10**: Exceptional fit — exceeds your criteria
- **7–8**: Strong fit — meets most/all criteria
- **5–6**: Acceptable — meets minimum, some gaps
- **3–4**: Weak — significant mismatches
- **1–2**: Poor fit — contradicts your priorities

## Hard nos (binary)

Before scoring, the system checks for walk-away criteria:
- Crypto, gambling, adult, or weapons industries
- Hero/burnout culture signals
- 5-day in-office mandate
- Founder/CEO red flags

If any hard no is triggered, the role gets a **FAIL** regardless of dimension scores.

## Tension surfacing

Every score report includes a "Tensions" section that flags where the role creates trade-offs between your competing priorities (e.g. lifestyle vs growth ambition, cash preference vs scaleup equity norms).

## What the scorer CAN'T assess

- Manager quality (requires meeting them)
- Actual hours culture (JDs always understate)
- Real equity value (requires cap table access)
- Team dynamics (requires references)

The scorer flags these as "needs discovery" items for your interview process.

## Updating the methodology

Edit `config/evaluation-profile.md` to change weights, thresholds, or criteria. The scorer reads the profile dynamically — changes take effect on the next score run.
