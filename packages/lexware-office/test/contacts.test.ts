import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contactProblems, createCustomer, planCustomerUpdate, updateBlockers, updateCustomer, type ContactDetails } from "../src/index.ts";
import { fakeApi, on } from "./fake-api.ts";

const company: ContactDetails = {
  id: "c-1",
  version: 3,
  roles: { customer: { number: 10001 } },
  company: { name: "Beispiel GmbH", contactPersons: [{ firstName: "Erika", lastName: "Muster", primary: true }] },
  addresses: { billing: [{ street: "Musterstraße 1", zip: "12345", city: "Musterstadt", countryCode: "DE" }] },
  emailAddresses: { business: ["info@example.com"] },
};

describe("createCustomer", () => {
  it("sends every writable field of a company", async () => {
    const api = fakeApi(
      on("POST", /^\/contacts$/, () => ({ id: "c-9" })),
      on("GET", /^\/contacts\/c-9$/, () => ({ id: "c-9", roles: { customer: { number: 10009 } }, company: { name: "Beispiel GmbH" } })),
    );
    const created = await createCustomer(api.client, {
      company: {
        name: "Beispiel GmbH",
        taxNumber: "12345/12345",
        vatRegistrationId: "DE 123 456 789",
        allowTaxFreeInvoices: false,
        contactPerson: { salutation: "Frau", firstName: "Erika", lastName: "Muster", primary: true, emailAddress: "erika@example.com" },
      },
      billingAddress: { street: "Musterstraße 1", zip: "12345", city: "Musterstadt" },
      shippingAddress: { supplement: "Lager", street: "Lagerweg 2", zip: "12345", city: "Musterstadt", countryCode: "at" },
      xRechnung: { buyerReference: "04011000-1234512345-35", vendorNumberAtCustomer: "70123456" },
      email: "info@example.com",
      emailAddresses: { office: "buero@example.com" },
      phoneNumbers: { mobile: "0151 0000000" },
      note: "Intern",
    });

    assert.deepEqual(created, { id: "c-9", customerNumber: 10009, name: "Beispiel GmbH" });
    assert.deepEqual(api.calls[0]!.body, {
      version: 0,
      roles: { customer: {} },
      company: {
        name: "Beispiel GmbH",
        taxNumber: "12345/12345",
        vatRegistrationId: "DE123456789",
        allowTaxFreeInvoices: false,
        contactPersons: [{ salutation: "Frau", firstName: "Erika", lastName: "Muster", primary: true, emailAddress: "erika@example.com" }],
      },
      addresses: {
        billing: [{ street: "Musterstraße 1", zip: "12345", city: "Musterstadt", countryCode: "DE" }],
        shipping: [{ supplement: "Lager", street: "Lagerweg 2", zip: "12345", city: "Musterstadt", countryCode: "AT" }],
      },
      xRechnung: { buyerReference: "04011000-1234512345-35", vendorNumberAtCustomer: "70123456" },
      emailAddresses: { business: ["info@example.com"], office: ["buero@example.com"] },
      phoneNumbers: { mobile: ["0151 0000000"] },
      note: "Intern",
    });
  });

  it("refuses a Leitweg-ID without the vendor number before sending", async () => {
    const api = fakeApi();
    await assert.rejects(
      createCustomer(api.client, {
        company: { name: "Amt Beispielstadt" },
        xRechnung: { buyerReference: "04011000-1234512345-35", vendorNumberAtCustomer: "" },
      }),
      /Lieferantennummer/,
    );
    assert.equal(api.calls.length, 0);
  });
});

describe("contactProblems", () => {
  it("names a salutation that is too long and a note over 1000 characters", () => {
    const problems = contactProblems({ person: { salutation: "x".repeat(26), lastName: "Muster" }, note: "x".repeat(1001) });
    assert.equal(problems.length, 2);
  });
});

describe("planCustomerUpdate", () => {
  it("merges changes, keeps the rest and lists what changes", () => {
    const plan = planCustomerUpdate(company, {
      company: { vatRegistrationId: "DE123456789", contactPerson: { phoneNumber: "07000 000000" } },
      billingAddress: { street: "Neue Straße 5" },
      emailAddresses: { business: null, office: "buero@example.com" },
    });

    assert.deepEqual(plan.body, {
      version: 3,
      roles: { customer: {} },
      company: {
        name: "Beispiel GmbH",
        vatRegistrationId: "DE123456789",
        contactPersons: [{ firstName: "Erika", lastName: "Muster", primary: true, phoneNumber: "07000 000000" }],
      },
      addresses: { billing: [{ street: "Neue Straße 5", zip: "12345", city: "Musterstadt", countryCode: "DE" }] },
      emailAddresses: { office: ["buero@example.com"] },
    });
    assert.deepEqual(
      plan.changes.map((change) => change.field),
      [
        "company.vatRegistrationId",
        "company.contactPerson.phoneNumber",
        "addresses.billing.street",
        "emailAddresses.business",
        "emailAddresses.office",
      ],
    );
    assert.deepEqual(plan.changes[0], { field: "company.vatRegistrationId", before: "", after: "DE123456789" });
  });

  it("removes the contact person with null", () => {
    const plan = planCustomerUpdate(company, { company: { contactPerson: null } });
    assert.equal((plan.body.company as { contactPersons?: unknown }).contactPersons, undefined);
  });

  it("refuses a contact with two billing addresses", () => {
    const two = { ...company, addresses: { billing: [company.addresses!.billing![0]!, company.addresses!.billing![0]!] } };
    assert.deepEqual(updateBlockers(two), ["addresses.billing"]);
    assert.throws(() => planCustomerUpdate(two, { note: "x" }), /addresses\.billing/);
  });

  it("refuses person fields on a company", () => {
    assert.throws(() => planCustomerUpdate(company, { person: { lastName: "Muster" } }), /Firma/);
  });
});

describe("updateCustomer", () => {
  it("writes with the version it read", async () => {
    let version = 3;
    const api = fakeApi(
      on("GET", /^\/contacts\/c-1$/, () => ({ ...company, version })),
      on("PUT", /^\/contacts\/c-1$/, () => {
        version = 4;
        return { id: "c-1", version: 4 };
      }),
    );
    const updated = await updateCustomer(api.client, "c-1", { note: "Neu" }, { expectedVersion: 3 });

    assert.equal((api.calls[1]!.body as { version: number }).version, 3);
    assert.deepEqual(updated, { id: "c-1", version: 4, customerNumber: 10001, name: "Beispiel GmbH", changes: [{ field: "note", before: "", after: "Neu" }] });
  });

  it("stops when the contact changed since the expected version", async () => {
    const api = fakeApi(on("GET", /^\/contacts\/c-1$/, () => ({ ...company, version: 5 })));
    await assert.rejects(updateCustomer(api.client, "c-1", { note: "Neu" }, { expectedVersion: 3 }), /^Error: Abgebrochen/);
    assert.equal(api.calls.filter((call) => call.method === "PUT").length, 0);
  });

  it("does not write when nothing changes", async () => {
    const api = fakeApi(on("GET", /^\/contacts\/c-1$/, () => company));
    const updated = await updateCustomer(api.client, "c-1", { emailAddresses: { business: "info@example.com" } });
    assert.deepEqual(updated.changes, []);
    assert.equal(api.calls.length, 1);
  });
});
