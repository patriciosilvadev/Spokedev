import logger from "../../logger";
import { CampaignContact, r, cacheableData } from "../models";
import { mapFieldsToModel } from "./lib/utils";
import { getTopMostParent, zipToTimeZone } from "../../lib";
import { accessRequired } from "./errors";

export const resolvers = {
  Location: {
    timezone: zipCode => zipCode || {},
    city: zipCode => zipCode.city || "",
    state: zipCode => zipCode.state || ""
  },
  Timezone: {
    offset: zipCode => zipCode.timezone_offset || null,
    hasDST: zipCode => zipCode.has_dst || null
  },
  CampaignContact: {
    ...mapFieldsToModel(
      [
        "id",
        "firstName",
        "lastName",
        "cell",
        "zip",
        "customFields",
        "messageStatus",
        "assignmentId",
        "external_id"
      ],
      CampaignContact
    ),
    updatedAt: async campaignContact => {
      let updatedAt;
      if (
        campaignContact.updated_at &&
        campaignContact.updated_at !== "0000-00-00 00:00:00"
      ) {
        updatedAt = campaignContact.updated_at;
      } else if (Array.isArray(campaignContact.messages)) {
        const latestMessage =
          campaignContact.messages[campaignContact.messages.length - 1];
        updatedAt = latestMessage.created_at;
      } else {
        updatedAt = campaignContact.created_at;
      }

      return updatedAt;
    },
    messageStatus: async (campaignContact, _, { loaders }) => {
      if (campaignContact.message_status) {
        return campaignContact.message_status;
      }
      // TODO: look it up via cacheing
    },
    campaign: async (campaignContact, _, { loaders }) =>
      loaders.campaign.load(campaignContact.campaign_id),
    // To get that result to look like what the original code returned
    // without using the outgoing answer_options array field, try this:
    //
    questionResponseValues: async (campaignContact, _, { loaders }) => {
      if (campaignContact.message_status === "needsMessage") {
        return []; // it's the beginning, so there won't be any
      }
      const qr_results = await r
        .knex("question_response")
        .join(
          "interaction_step as istep",
          "question_response.interaction_step_id",
          "istep.id"
        )
        .where("question_response.campaign_contact_id", campaignContact.id)
        .select(
          "value",
          "interaction_step_id",
          "istep.question as istep_question",
          "istep.id as istep_id"
        );
      return qr_results.map(qr_result => {
        const question = {
          id: qr_result.istep_id,
          question: qr_result.istep_question
        };
        return Object.assign({}, qr_result, { question });
      });
    },
    questionResponses: async (campaignContact, _, { loaders }) => {
      const results = await r
        .knex("question_response as qres")
        .where("qres.campaign_contact_id", campaignContact.id)
        .join(
          "interaction_step",
          "qres.interaction_step_id",
          "interaction_step.id"
        )
        .join(
          "interaction_step as child",
          "qres.interaction_step_id",
          "child.parent_interaction_id"
        )
        .select(
          "child.answer_option",
          "child.id",
          "child.parent_interaction_id",
          "child.created_at",
          "interaction_step.interaction_step_id",
          "interaction_step.campaign_id",
          "interaction_step.question",
          "interaction_step.script_options",
          "qres.id",
          "qres.value",
          "qres.created_at",
          "qres.interaction_step_id"
        )
        .catch(logger.error);

      let formatted = {};

      for (let i = 0; i < results.length; i++) {
        const res = results[i];

        const responseId = res["qres.id"];
        const responseValue = res["qres.value"];
        const answerValue = res["child.answer_option"];
        const interactionStepId = res["child.id"];

        if (responseId in formatted) {
          formatted[responseId]["parent_interaction_step"][
            "answer_options"
          ].push({
            value: answerValue,
            interaction_step_id: interactionStepId
          });
          if (responseValue === answerValue) {
            formatted[responseId]["interaction_step_id"] = interactionStepId;
          }
        } else {
          formatted[responseId] = {
            contact_response_value: responseValue,
            interaction_step_id: interactionStepId,
            parent_interaction_step: {
              answer_option: "",
              answer_options: [
                { value: answerValue, interaction_step_id: interactionStepId }
              ],
              campaign_id: res["interaction_step.campaign_id"],
              created_at: res["child.created_at"],
              id: responseId,
              parent_interaction_id:
                res["interaction_step.parent_interaction_id"],
              question: res["interaction_step.question"],
              scriptOptions: res["interaction_step.script_options"]
            },
            value: responseValue
          };
        }
      }
      return Object.values(formatted);
    },
    location: async (campaignContact, _, { loaders }) => {
      if (campaignContact.timezone_offset) {
        // couldn't look up the timezone by zip record, so we load it
        // from the campaign_contact directly if it's there
        const [offset, hasDst] = campaignContact.timezone_offset.split("_");
        const loc = {
          timezone_offset: parseInt(offset, 10),
          has_dst: hasDst === "1"
        };
        // From cache
        if (campaignContact.city) {
          loc.city = campaignContact.city;
          loc.state = campaignContact.state || undefined;
        }
        return loc;
      }
      const mainZip = campaignContact.zip.split("-")[0];
      const calculated = zipToTimeZone(mainZip);
      if (calculated) {
        return {
          timezone_offset: calculated[2],
          has_dst: calculated[3] === 1
        };
      }
      return await loaders.zipCode.load(mainZip);
    },
    messages: async campaignContact => {
      if ("messages" in campaignContact) {
        return campaignContact.messages;
      }

      let messages = await r
        .knex("message")
        .where({ campaign_contact_id: campaignContact.id })
        .orderBy("created_at");

      // This covers edge case campaign contacts from mid-February 2019
      if (
        messages.length === 0 &&
        campaignContact.message_status !== "needsMessage"
      ) {
        messages = await r
          .knex("message")
          .where({
            assignment_id: campaignContact.assignment_id,
            contact_number: campaignContact.cell
          })
          .orderBy("created_at");
      }

      return messages;
    },
    optOut: async (campaignContact, _, { loaders }) => {
      // `opt_out_cell` is a non-standard property from the conversations query
      if ("opt_out_cell" in campaignContact) {
        return {
          cell: campaignContact.opt_out_cell
        };
      } else {
        let isOptedOut = false;
        if (campaignContact.is_opted_out !== undefined) {
          isOptedOut = Boolean(campaignContact.is_opted_out);
        } else {
          let organizationId = campaignContact.organization_id;
          if (!organizationId) {
            const campaign = await loaders.campaign.load(
              campaignContact.campaign_id
            );
            organizationId = campaign.organization_id;
          }

          isOptedOut = await cacheableData.optOut.query({
            cell: campaignContact.cell,
            organizationId
          });
        }

        if (isOptedOut) {
          // fake ID so we don't need to look up existance
          return {
            id: "optout",
            cell: campaignContact.cell
          };
        }
        return null;
      }
    },
    contactTags: async (campaignContact, _, { user }) => {
      const { campaign_id } = campaignContact;
      const { organization_id } = await r
        .knex("campaign")
        .where({ id: campaign_id })
        .first("organization_id");
      await accessRequired(user, organization_id, "TEXTER");

      return r
        .knex("tag")
        .select("tag.*")
        .join(
          "campaign_contact_tag",
          "campaign_contact_tag.tag_id",
          "=",
          "tag.id"
        )
        .where(
          "campaign_contact_tag.campaign_contact_id",
          "=",
          campaignContact.id
        );
    }
  }
};
