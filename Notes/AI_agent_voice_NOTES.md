Suspicious Emails and texts asking to repay for delivery.

Rerouting of emails to concerned department --> overdue invoices to finance, retailer contact to sales, collaboration or influencer to marketing


Clients --> Returns and Refunds, Order Cancellations, Product Complaint, Product Informations, Order tracking, Promotion code help.
Other --> Overdue Invoices, Retailers, Collaborators


## AI agent context setup
To sync Shopify pages for company knowledge --> Drop down page select in UI --> Recommended = FAQ, Privacy Policy, Brand Name
This should then show up in UI --> changed by hand --> Reset to shopify button (are u sure popup)


Tickets analsis (runs weekly and updates the user on current trands in tickets, may need to store tickets for longer than 6 months, like a year)

Need to do some tests on agents, embedding efficieny and retreival etc. Checj how the embedding works, Am i doinf a full scan or am I building a graph and hopping to closest neighbours in smaller and smaller steps. measure retreival quality, look at hybrid search and reranking 


Optimising the agent, scope tools and control state with langraph

Draft modification, memory, so that it can remeber and improve over time. 

Check the evidence-rules.mjs:30

Make sure that the variants have a french, english, spanish and italian version of all the questions.
Make sure that the answers have been writtne yh 


Add the link of the tracking number to the drafting email so person can click directly

Pinable dashbord ( so you can pin specific metrics)

### Order cancellations and returns
Need to check with people how this works

Order Cancellation workflow:
    Can't be cancelled if it has been sent
    must be returned upon receiving parcel
    should get the tracking number for convenience in the message

Order Returns
    Should give the return adress if asked

### returns/exchanges/ product problem

WHen there is a product problem or the user wants a return or exchange due to a problem with the product or order, the agent should ask for photoevidence, as well as the name of the product in question

### Order


