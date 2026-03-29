// Shift 2026 — UI Constants
(function (S) {
  "use strict";

  S.MAX_VISIBLE = 9;

  S.CATEGORIES = [
    { label: "Pizza", value: "pizza", emoji: "\u{1F355}" },
    { label: "Burger", value: "burger", emoji: "\u{1F354}" },
    { label: "Sushi", value: "sushi", emoji: "\u{1F363}" },
    { label: "Asiatique", value: "asiatique", emoji: "\u{1F35C}" },
    { label: "Mexicain", value: "mexicain", emoji: "\u{1F32E}" },
    { label: "Italien", value: "italien", emoji: "\u{1F35D}" },
    { label: "Indien", value: "indien", emoji: "\u{1F35B}" },
    { label: "Poulet", value: "poulet", emoji: "\u{1F357}" },
    { label: "Healthy", value: "healthy", emoji: "\u{1F957}" },
    { label: "Kebab", value: "kebab", emoji: "\u{1F959}" },
    { label: "Poke", value: "poke bowl", emoji: "\u{1F96E}" },
    { label: "Dessert", value: "dessert", emoji: "\u{1F370}" },
  ];

  S.MOODS = [
    { label: "Reconfort", value: "reconfort", emoji: "\u{1F6CB}\u{FE0F}" },
    { label: "Leger", value: "leger", emoji: "\u{1F331}" },
    { label: "Festif", value: "festif", emoji: "\u{1F389}" },
    { label: "Rapide", value: "rapide", emoji: "\u{26A1}" },
    { label: "Gourmand", value: "gourmand", emoji: "\u{1F929}" },
  ];

  S.CATEGORY_PLACEHOLDERS = {
    pizza: [
      "J'aimerais une <b>pizza</b> avec de la mozza di buffala...",
      "Une <b>pizza</b> pepperoni bien fromagée...",
      "Une <b>pizza</b> quatre fromages croustillante...",
    ],
    burger: [
      "Un smash <b>burger</b> bien juteux avec du cheddar...",
      "Un <b>burger</b> classique bacon-cheese fondant...",
      "Un double <b>burger</b> avec sauce maison...",
    ],
    sushi: [
      "Un plateau de <b>sushi</b> california rolls et sashimi...",
      "Des <b>sushi</b> saumon avocat bien frais...",
      "Un menu <b>sushi</b> mixte avec edamame...",
    ],
    asiatique: [
      "Un bo bun frais avec des nems croustillants...",
      "Un pad thaï aux crevettes bien <b>asiatique</b>...",
      "Des raviolis vapeur et riz cantonais...",
    ],
    mexicain: [
      "Des tacos al pastor avec guacamole maison...",
      "Un burrito <b>mexicain</b> poulet bien garni...",
      "Des quesadillas fromage et pico de gallo...",
    ],
    italien: [
      "Des penne all'arrabbiata bien relevées...",
      "Un risotto crémeux aux champignons <b>italien</b>...",
      "Des lasagnes maison avec bolognaise fondante...",
    ],
    indien: [
      "Un butter chicken bien crémeux avec du naan...",
      "Un tikka masala <b>indien</b> avec riz basmati...",
      "Des samosas croustillants et dal onctueux...",
    ],
    poulet: [
      "Du <b>poulet</b> croustillant avec une sauce barbecue...",
      "Des tenders de <b>poulet</b> avec frites maison...",
      "Un <b>poulet</b> rôti bien doré avec légumes grillés...",
    ],
    healthy: [
      "Une salade bowl avec avocat et saumon grillé...",
      "Un buddha bowl <b>healthy</b> quinoa et légumes...",
      "Un açaï bowl <b>healthy</b> avec granola et fruits...",
    ],
    kebab: [
      "Un <b>kebab</b> galette avec sauce blanche et harissa...",
      "Un <b>kebab</b> assiette avec frites et salade...",
      "Un durum <b>kebab</b> bien garni sauce samouraï...",
    ],
    "poke bowl": [
      "Un <b>poke bowl</b> saumon mangue et edamame...",
      "Un <b>poke bowl</b> thon avocat sauce sésame...",
      "Un <b>poke bowl</b> crevettes et ananas frais...",
    ],
    dessert: [
      "Un fondant au chocolat avec coeur coulant...",
      "Une crème brûlée onctueuse en <b>dessert</b>...",
      "Un tiramisu maison bien café en <b>dessert</b>...",
    ],
  };

  S.DEFAULT_PLACEHOLDER = [
    "<b>Pizza</b> chèvre miel, un truc réconfortant, <b>sushi</b>...",
    "Un bon <b>burger</b>, des <b>sushi</b>, ou autre chose ?",
    "Envie de <b>thaï</b>, de <b>mexicain</b>, ou de comfort food ?",
  ];

  S.LOADING_MARKETING_FACTS = [
    "Les promotions affichees par Uber Eats favorisent souvent davantage les restaurants que les consommateurs.",
    "Uber Eats augmente les prix des produits en fonction de l'affluence et de l'attractivite d'une enseigne.",
    "Le COVID-19 a fortement propulse le business d'Uber Eats.",
    "Uber Eats n'est toujours pas rentable et reste opaque sur ses comptes.",
  ];

  S.DEFAULT_BOTTOM_PLACEHOLDERS = [
    "Moins cher ?",
    "Plus rapide à livrer ?",
    "Autre chose ?",
    "Un dessert avec ?",
    "Sans gluten ?",
  ];
})(window.Shift);
