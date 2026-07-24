# This Document Describes the inital planned structure for the agent workflow that needs to be refined.

Tickets will be the term and method used to track conversations

When an email enters inbox, a ticket is created automatically (a data table with certain feilds that will be filled out by the categorising agent)
The categorising agent then then fills out the the important parts of the data table particularly the category (order question, dilvery issue, product question) and Level (Question only level 1; Data look-up required level 2; State changing operation required Level 3; Sensitive level 4)

Level 1: No human
Level 2: No human (may suggest human action)
Level 3: Human action
Level 4: Manager Human Action

Once the category and level is decided the subagents and automations can begin to act. By calling upon the tools that we will create (e.g. Find Tracking number tool), Querying the correct knowledge bases (whether its the embedded database or the product, client or oder tables, or both), memory (if this can be handled later perhaps could be good) and ofc guidlines (first blocker is restricting agent roles to only what it needs to do the job)

Most common types of Questions types are:

Where are my Order? --> For this type of question agent should employ the tool where it starts filling out Shopify order number (from email content, from email adress matching, from asking for it if not provided in that email in that order). With this key bit of info the correct rows in the order table can be found (without searxhing the whole database, when searching for order number only relevant columns should be queried ofc.). With the correct order number, this can be matched to the small client CRM table to get information like total number of orders, RFM group (for priority), the registered name on the order (in some cases this could differ from the person writing). This is the type of information gathering that would be beneficial in any sort of order, tracking, even product complaint, promo on order question, return and refund etc. 

I also think the shopify order number is a good consistent source of truth look-up variable that this workflow should rely on to gather the correct info.

Therefore if the shopify order number is not given when the category requires it (basically applies most of the time unless more general product questions, advice), the firs response email should asking if they can provide the shopify order number #XXXX

Sometimes the shopify order number was never given to the customer, so the agent should do first pas email check to see if an order was made recently and check the contents of order with the customer if there is a match. If there is no match then the agent should ask for the email, name and billing adress used for the order. email match is considered safe but name and adress match isn't so a human at that stage would have to verify details.

Other questions include

What product would you recommend for dark spots close to the eyes?

This is a type of questino that would not neccesitate to try and figure out the order number. Here the agent should draw on prouduct info to answer this question cleanly. again ideall the agent does not query the entire database but select tables which would allow to reduce the number of rows that are queried. this will be laid out in the tool calls I imagine.

Question from B2B, invoice delays, marketing, influencers, freelancers etc happen a lot and they should just be forwarded to the inbox of teh reposinsible people in the organisation (finance, marketing, sales, logisitics). THese are the four team responsibe category + the contact team ofc that will able to filter tickets for the responsible person, so even the other teams can check if they have any outstanding tickets. 

There should be a quick token efficient way to sort out any sort of spam email, to filter quickly any irrelevant emails (otherwise this can use up a lot of tokens)

Finally its very important that tickets dont work as individual emails but as conversations (multiple emails)

# most common categories 

| Dashboard Category                    | Expected Share | Why it matters                                      |
| ------------------------------------- | -------------- | --------------------------------------------------- |
| **Order Status**                      | **30–40%**     | Largest automation opportunity                      |
| **Delivery Issue**                    | **10–15%**     | Often courier-linked, useful for logistics analysis |
| **Returns / Refunds / Exchanges**     | **10–15%**     | Requires policy + action                            |
| **Product Advice / Usage**            | **12–18%**     | Important in cosmetics; can be AI-assisted          |
| **Product / Order Problem**           | **10–15%**     | Missing item, wrong item, defective packaging       |
| **Marketing / Promo / Loyalty**       | **6–10%**      | Usually simple but frequent during campaigns        |
| **Account / Payment / Subscription**  | **5–8%**       | Usually action required                             |
| **Safety / Adverse Reaction / Legal** | **1–4%**       | Low volume, high risk                               |






