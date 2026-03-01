#!/usr/bin/env python3
"""
Seed the people and people_emails tables from the PostgreSQL contributors page.
Safe to re-run — all inserts use ON CONFLICT DO NOTHING.
"""

import os
import re
import sys

import psycopg2
from dotenv import load_dotenv

load_dotenv()
from psycopg2.extras import execute_batch

DSN = os.environ.get("DATABASE_URL", "postgresql://pginbox:pginbox@localhost:5499/pginbox")

# ---------------------------------------------------------------------------
# Contributor data from https://www.postgresql.org/community/contributors/
# Significant contributors (email-only entries) are omitted — no canonical
# name available; they can be added later via name-matching against messages.
# ---------------------------------------------------------------------------

CONTRIBUTORS = [
    # (name, [emails])
    # --- Core Team ---
    ("Peter Eisentraut",    ["peter.eisentraut@enterprisedb.com"]),
    ("Andres Freund",       ["andres@anarazel.de"]),
    ("Magnus Hagander",     ["magnus@hagander.net"]),
    ("Jonathan Katz",       ["jonathan.katz@excoventures.com"]),
    ("Tom Lane",            ["tgl@sss.pgh.pa.us"]),
    ("Bruce Momjian",       ["bruce@momjian.us"]),
    ("Dave Page",           ["dpage@pgadmin.org"]),

    # --- Major Contributors ---
    ("Laurenz Albe",        ["laurenz.albe@cybertec.at"]),
    ("Ashutosh Bapat",      ["ashutosh.bapat.oss@gmail.com"]),
    ("Oleg Bartunov",       ["obartunov@gmail.com"]),
    ("Christoph Berg",      ["myon@debian.org"]),
    ("Andrey Borodin",      ["x4mmm@yandex-team.ru"]),
    ("Nathan Bossart",      ["nathandbossart@gmail.com"]),
    ("Jacob Champion",      ["champion.p@gmail.com"]),
    ("Joe Conway",          ["mail@joeconway.com"]),
    ("Dave Cramer",         ["davec@postgresintl.com"]),
    ("Jeff Davis",          ["pgsql@j-davis.com"]),
    ("Bertrand Drouvot",    ["bertranddrouvot.pg@gmail.com"]),
    ("Andrew Dunstan",      ["andrew@dunslane.net"]),
    ("Jelte Fennema-Nio",   ["postgres@jeltef.nl"]),
    ("Etsuro Fujita",       ["etsuro.fujita@gmail.com"]),
    ("Peter Geoghegan",     ["pg@bowt.ie"]),
    ("Devrim Gündüz",       ["devrim@gunduz.org"]),
    ("Richard Guo",         ["guofenglinux@gmail.com"]),
    ("Daniel Gustafsson",   ["daniel@yesql.se"]),
    ("Robert Haas",         ["robertmhaas@gmail.com"]),
    ("Stacey Haysler",      ["shayslerpgx@gmail.com"]),
    ("Álvaro Herrera",      ["alvherre@alvh.no-ip.org"]),
    ("Kyotaro Horiguchi",   ["horikyota_ntt@gmail.com"]),
    ("Tatsuo Ishii",        ["ishii@postgresql.org"]),
    ("Petr Jelinek",        ["petr.jelinek@enterprisedb.com"]),
    ("Stefan Kaltenbrunner",["stefan@kaltenbrunner.cc"]),
    ("Amit Kapila",         ["amit.kapila16@gmail.com"]),
    ("Alexander Korotkov",  ["aekorotkov@gmail.com"]),
    ("Alexander Lakhin",    ["exclusion@gmail.com"]),
    ("Amit Langote",        ["amitlangote09@gmail.com"]),
    ("Guillaume Lelarge",   ["guillaume@lelarge.info"]),
    ("Heikki Linnakangas",  ["heikki.linnakangas@iki.fi"]),
    ("Anastasia Lubennikova",["lubennikovaav@gmail.com"]),
    ("Fujii Masao",         ["masao.fujii@gmail.com"]),
    ("Noah Misch",          ["noah@leadboat.com"]),
    ("Thomas Munro",        ["thomas.munro@gmail.com"]),
    ("John Naylor",         ["john.naylor@postgresql.org"]),
    ("Michael Paquier",     ["michael@paquier.xyz"]),
    ("Paul Ramsey",         ["pramsey@cleverelephant.ca"]),
    ("Dean Rasheed",        ["dean.a.rasheed@gmail.com"]),
    ("Julien Rouhaud",      ["rjuju123@gmail.com"]),
    ("David Rowley",        ["dgrowleyml@gmail.com"]),
    ("Greg Sabino Mullane", ["greg@turnstep.com"]),
    ("Masahiko Sawada",     ["sawada.mshk@gmail.com"]),
    ("Andreas Scherbaum",   ["ads@pgug.de"]),
    ("Teodor Sigaev",       ["teodor@sigaev.ru"]),
    ("Steve Singer",        ["steve@ssinger.info"]),
    ("Pavel Stehule",       ["pavel.stehule@gmail.com"]),
    ("Robert Treat",        ["rob@xzilla.net"]),
    ("Tomas Vondra",        ["tomas@vondra.me"]),
    ("Mark Wong",           ["markwkm@gmail.com"]),
    ("Hou Zhijie",          ["houzj.fnst@fujitsu.com"]),

    # --- Extended Contributors (sourced from message activity) ---
    ("Peter Smith",             ["smithpb2250@gmail.com"]),
    ("Jian He",                 ["jian.universality@gmail.com"]),
    ("Melanie Plageman",        ["melanieplageman@gmail.com"]),
    ("Vignesh C",               ["vignesh21@gmail.com"]),
    ("Hayato Kuroda",           ["kuroda.hayato@fujitsu.com"]),
    ("David G. Johnston",       ["david.g.johnston@gmail.com"]),
    ("Shveta Malik",            ["shveta.malik@gmail.com"]),
    ("Bharath Rupireddy",       ["bharath.rupireddyforpostgres@gmail.com"]),
    ("Chao Li",                 ["li.evan.chao@gmail.com"]),
    ("Aleksander Alekseev",     ["aleksander@timescale.com"]),
    ("Dilip Kumar",             ["dilipbalaut@gmail.com"]),
    ("Justin Pryzby",           ["pryzby@telsasoft.com", "pryzbyj@telsasoft.com"]),
    ("Sami Imseih",             ["samimseih@gmail.com"]),
    ("Matthias van de Meent",   ["boekewurm@gmail.com"]),
    ("Nazir Bilal Yavuz",       ["byavuz81@gmail.com"]),
    ("Corey Huinker",           ["corey.huinker@gmail.com"]),
    ("Ranier Vilela",           ["ranier.vf@gmail.com"]),
    ("Kirill Reshke",           ["reshkekirill@gmail.com"]),
    ("Yugo Nagata",             ["nagata@sraoss.co.jp"]),
    ("Antonin Houska",          ["ah@cybertec.at"]),
    ("Joel Jacobson",           ["joel@compiler.org"]),
    ("Japin Li",                ["japinli@hotmail.com"]),
    ("Dagfinn Ilmari Mannsåker",["ilmari@ilmari.org"]),
    ("Andrei Lepikhov",         ["lepihov@gmail.com"]),
    ("Jim Jones",               ["jim.jones@uni-muenster.de"]),
    ("David E. Wheeler",        ["david@justatheory.com"]),
    ("Sutou Kouhei",            ["kou@clear-code.com"]),
    ("Junwang Zhao",            ["zhjwpku@gmail.com"]),
    ("Shlok Kyal",              ["shlok.kyal.oss@gmail.com"]),
    ("Andy Fan",                ["zhihuifan1213@163.com"]),
    ("Euler Taveira",           ["euler@eulerto.com"]),
    ("Dmitry Dolgov",           ["9erthalion6@gmail.com"]),
    ("Tristan Partin",          ["tristan@neon.tech"]),
    ("torikoshia",              ["torikoshia@oss.nttdata.com"]),
    ("Jakub Wartak",            ["jakub.wartak@enterprisedb.com"]),
    ("Shubham Khanna",          ["khannashubham1197@gmail.com"]),
    ("Xuneng Zhou",             ["xunengzhou@gmail.com"]),
    ("Matheus Alcantara",       ["matheusssilv97@gmail.com"]),

    # --- Past Major Contributors ---
    ("Josh Berkus",         ["josh@agliodbs.com"]),
    ("David Fetter",        ["david@fetter.org"]),
    ("Marc G. Fournier",    ["marc.fournier@enterprisedb.com"]),
    ("Stephen Frost",       ["sfrost@snowman.net"]),
    ("Andrew Gierth",       ["andrew@tao11.riddles.org.uk"]),
    ("Thomas G. Lockhart",  ["lockhart@alumni.caltech.edu"]),
    ("Michael Meskes",      ["meskes@postgresql.org"]),
    ("Vadim B. Mikheev",    ["vadim4o@yahoo.com"]),
    ("Jan Wieck",           ["jan@wi3ck.info"]),
]


def _normalize_email(addr: str) -> str:
    addr = addr.lower().strip()
    return re.sub(r'\+[^@]*@', '@', addr)


def seed(conn):
    inserted_people = 0
    inserted_emails = 0

    with conn.cursor() as cur:
        for name, emails in CONTRIBUTORS:
            cur.execute(
                "INSERT INTO people (name) VALUES (%s) ON CONFLICT DO NOTHING RETURNING id",
                (name,),
            )
            row = cur.fetchone()
            if row is None:
                cur.execute("SELECT id FROM people WHERE name = %s", (name,))
                row = cur.fetchone()
            else:
                inserted_people += 1
            person_id = row[0]

            for raw_email in emails:
                email = _normalize_email(raw_email)
                cur.execute(
                    "INSERT INTO people_emails (person_id, email) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                    (person_id, email),
                )
                if cur.rowcount:
                    inserted_emails += 1

    conn.commit()
    print(f"Seeded {inserted_people} people, {inserted_emails} email addresses.")
    print("(Rows already present were skipped — safe to re-run.)")


if __name__ == "__main__":
    conn = psycopg2.connect(DSN)
    seed(conn)
    conn.close()
